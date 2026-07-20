'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const PLAYER_ID = '119516088528998@lid';
const EXPECTED_NAME = 'Vitor';
const REQUIRED_CONFIRMATION = 'REPAIR_VITOR_ACCESS_REGRESSION';
const REPAIR_ACTOR = 'system:repair-profile-confirmation-regression';

function normalizeText(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

function playerName(player = {}) {
    return [player.personagem_nome, player.display_name, player.nome, player.nome_real]
        .map((value) => String(value || '').trim())
        .find((value) => value && value !== '-') || '';
}

function isApproved(value) {
    return ['aprovada', 'aprovado', 'confirmada', 'confirmado'].includes(normalizeText(value));
}

function isPending(value) {
    return ['pending', 'pendente'].includes(normalizeText(value));
}

function isRejected(value) {
    return ['negada', 'rejeitada', 'reprovada', 'rejected'].includes(normalizeText(value));
}

function isActiveLifecycle(player = {}) {
    const identity = normalizeText(player.identity_status || 'active');
    const lifecycle = normalizeText(player.lifecycle_status || 'active');
    return identity === 'active'
        && lifecycle === 'active'
        && Number(player.is_shadow || 0) === 0
        && !player.merged_into;
}

function matchesRegressionSignature(player = {}) {
    return isApproved(player.ficha_status)
        && isPending(player.personagem_aparencia_status)
        && !isRejected(player.historia_status)
        && normalizeText(player.jogo_status) === 'bloqueado'
        && !player.jogo_bloqueio_motivo
        && !player.jogo_liberado_at
        && !player.jogo_liberado_by
        && isActiveLifecycle(player);
}

function hasReleaseEvidence(onboarding = {}) {
    if (normalizeText(onboarding.current_step) !== 'jogo_liberado') return false;
    let payload = {};
    try {
        payload = JSON.parse(onboarding.step_payload || '{}');
    } catch {
        return false;
    }
    return normalizeText(payload.last_message).includes('jogo_liberado');
}

async function readState(db) {
    const player = await db.get('SELECT * FROM jogadores WHERE id = ?', [PLAYER_ID]);
    const onboarding = await db.get('SELECT * FROM player_onboarding WHERE player_id = ?', [PLAYER_ID]);
    return { player, onboarding };
}

async function createBackup(db, databaseFile, outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });
    await db.exec('PRAGMA wal_checkpoint(FULL)');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(outputDir, `before-vitor-access-repair-${stamp}.sqlite`);
    fs.copyFileSync(databaseFile, backupFile);
    return backupFile;
}

function assertExpectedState(state) {
    const { player, onboarding } = state;
    if (!player) throw new Error(`Cadastro não encontrado: ${PLAYER_ID}`);

    const foundName = playerName(player);
    if (normalizeText(foundName) !== normalizeText(EXPECTED_NAME)) {
        throw new Error(`Identidade divergente. Esperado: ${EXPECTED_NAME}; encontrado: ${foundName || '-'}`);
    }

    if (!isActiveLifecycle(player)) {
        throw new Error('Vitor não está em identidade e ciclo de vida ativos. Nada será alterado.');
    }

    if (normalizeText(player.jogo_status) === 'liberado') {
        return { alreadyReleased: true, foundName };
    }

    if (!matchesRegressionSignature(player)) {
        throw new Error('O cadastro não possui a assinatura exata da regressão conhecida. Nada será alterado.');
    }

    if (!onboarding || !hasReleaseEvidence(onboarding)) {
        throw new Error('O onboarding não comprova a liberação anterior de Vitor. Nada será alterado.');
    }

    return { alreadyReleased: false, foundName };
}

async function assertDatabaseIntegrity(db) {
    const foreignKeys = await db.all('PRAGMA foreign_key_check');
    if (foreignKeys.length) {
        throw new Error(`foreign_key_check encontrou ${foreignKeys.length} falha(s).`);
    }

    const integrityRows = await db.all('PRAGMA integrity_check');
    const failures = integrityRows
        .flatMap((row) => Object.values(row))
        .filter((value) => String(value).toLowerCase() !== 'ok');
    if (failures.length) throw new Error(`integrity_check falhou: ${failures.join('; ')}`);
}

async function repairVitorAccess(options = {}) {
    const databaseFile = path.resolve(options.databaseFile || 'banco.sqlite');
    const outputDir = path.resolve(options.outputDir || 'backups');
    const apply = options.apply === true;
    const confirmation = String(options.confirmation || '');

    if (!fs.existsSync(databaseFile)) throw new Error(`Banco não encontrado: ${databaseFile}`);
    if (apply && confirmation !== REQUIRED_CONFIRMATION) {
        throw new Error(`Aplicação exige --confirm=${REQUIRED_CONFIRMATION}`);
    }

    const db = await open({
        filename: databaseFile,
        driver: sqlite3.Database,
        mode: sqlite3.OPEN_READWRITE,
    });

    let backupFile = null;
    let report;

    try {
        await db.exec('PRAGMA busy_timeout = 15000');
        await db.exec('PRAGMA foreign_keys = ON');

        const before = await readState(db);
        const validation = assertExpectedState(before);

        if (validation.alreadyReleased) {
            await assertDatabaseIntegrity(db);
            report = {
                generatedAt: new Date().toISOString(),
                mode: apply ? 'apply' : 'dry_run',
                committed: false,
                alreadyReleased: true,
                repaired: false,
                playerId: PLAYER_ID,
                playerName: validation.foundName,
                backupFile: null,
                before: before.player,
                after: before.player,
            };
            return report;
        }

        if (apply) backupFile = await createBackup(db, databaseFile, outputDir);

        await db.exec('BEGIN IMMEDIATE');
        try {
            const result = await db.run(
                `UPDATE jogadores
                 SET jogo_status = 'liberado',
                     jogo_liberado_at = COALESCE(
                         (SELECT last_seen_at FROM player_onboarding WHERE player_id = jogadores.id),
                         historia_status_updated_at,
                         CURRENT_TIMESTAMP
                     ),
                     jogo_liberado_by = ?,
                     jogo_bloqueio_motivo = NULL
                 WHERE id = ?
                   AND ficha_status IN ('aprovada', 'aprovado', 'confirmada', 'confirmado')
                   AND personagem_aparencia_status IN ('pending', 'pendente')
                   AND LOWER(COALESCE(jogo_status, '')) = 'bloqueado'
                   AND jogo_bloqueio_motivo IS NULL
                   AND jogo_liberado_at IS NULL
                   AND jogo_liberado_by IS NULL
                   AND COALESCE(identity_status, 'active') = 'active'
                   AND COALESCE(lifecycle_status, 'active') = 'active'
                   AND COALESCE(is_shadow, 0) = 0
                   AND merged_into IS NULL`,
                [REPAIR_ACTOR, PLAYER_ID]
            );

            if (Number(result?.changes || 0) !== 1) {
                throw new Error(`Atualização condicional inesperada: ${result?.changes || 0} linha(s).`);
            }

            const after = await readState(db);
            if (normalizeText(after.player?.jogo_status) !== 'liberado') {
                throw new Error('Vitor não ficou liberado após a reparação.');
            }
            if (!after.player?.jogo_liberado_at || after.player?.jogo_liberado_by !== REPAIR_ACTOR) {
                throw new Error('Os metadados da reparação não foram registrados corretamente.');
            }
            if (!hasReleaseEvidence(after.onboarding)) {
                throw new Error('A evidência de onboarding mudou durante a reparação.');
            }

            await assertDatabaseIntegrity(db);
            if (apply) await db.exec('COMMIT');
            else await db.exec('ROLLBACK');

            report = {
                generatedAt: new Date().toISOString(),
                mode: apply ? 'apply' : 'dry_run',
                committed: apply,
                alreadyReleased: false,
                repaired: true,
                playerId: PLAYER_ID,
                playerName: validation.foundName,
                repairActor: REPAIR_ACTOR,
                backupFile,
                before: before.player,
                releaseEvidence: before.onboarding,
                after: after.player,
            };
        } catch (error) {
            await db.exec('ROLLBACK').catch(() => {});
            throw error;
        }
    } finally {
        await db.close();
    }

    fs.mkdirSync(outputDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reportFile = path.join(outputDir, `vitor-access-repair-${stamp}.json`);
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf8');
    report.reportFile = reportFile;
    return report;
}

async function main() {
    const args = process.argv.slice(2);
    const databaseFile = args.find((arg) => arg.startsWith('--db='))?.slice('--db='.length) || 'banco.sqlite';
    const outputDir = args.find((arg) => arg.startsWith('--output='))?.slice('--output='.length) || 'backups';
    const apply = args.includes('--apply');
    const confirmation = args.find((arg) => arg.startsWith('--confirm='))?.slice('--confirm='.length) || '';

    const result = await repairVitorAccess({ databaseFile, outputDir, apply, confirmation });
    console.log('\n=== REPARAÇÃO DE ACESSO — VITOR ===');
    console.log(`Modo: ${apply ? 'APLICAÇÃO' : 'SIMULAÇÃO COM ROLLBACK'}`);
    console.log(`Já liberado: ${result.alreadyReleased ? 'sim' : 'não'}`);
    console.log(`Reparado nesta execução: ${result.repaired ? 'sim' : 'não'}`);
    console.log(`Commit no banco: ${result.committed ? 'sim' : 'não'}`);
    console.log(`Backup: ${result.backupFile || 'não necessário'}`);
    console.log(`Relatório: ${result.reportFile || 'não criado'}`);
}

if (require.main === module) {
    main().catch((error) => {
        console.error('\nFALHA NA REPARAÇÃO DE VITOR:');
        console.error(error?.stack || error);
        process.exitCode = 1;
    });
}

module.exports = {
    EXPECTED_NAME,
    PLAYER_ID,
    REPAIR_ACTOR,
    REQUIRED_CONFIRMATION,
    hasReleaseEvidence,
    matchesRegressionSignature,
    repairVitorAccess,
};
