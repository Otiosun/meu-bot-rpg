'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    addPhInTransaction,
    ensurePhState,
} = require('../helpers/clover/phService');

const DB_PATH = path.resolve(__dirname, '..', 'banco.sqlite');
const BACKUP_DIR = path.resolve(__dirname, '..', 'backups');

const EVENT_KEY = 'exame-admissao-2026-07-31';
const EVENT_SOURCE = 'evento_exame_admissao';
const EVENT_REASON = 'Participação no Exame de Admissão — 1ª/2ª fase';
const ACTOR_ID = 'local-admin:correcao-participantes-exame-2026-07-31';
const PH_AMOUNT = 60;
const APPLY_CONFIRMATION = 'APLICAR-CORRECAO-EXAME-2026-07-31';

// Estes são somente os 9 participantes que ficaram fora do lote original.
// Os 20 já recompensados não aparecem aqui e, portanto, não podem ser alterados.
const TARGETS = [
    {
        playerLabel: 'Venus',
        characterLabel: 'Celeste',
        playerId: '558193421445@s.whatsapp.net',
        acceptedCharacterNames: ['Celeste Mist'],
        result: 'reprovada',
    },
    {
        playerLabel: 'Autorita',
        characterLabel: 'Firefly',
        playerId: '16200784429134@lid',
        acceptedCharacterNames: ['Firefly'],
        result: 'reprovado',
    },
    {
        playerLabel: 'Eren',
        characterLabel: 'Hyakuya',
        playerId: '191568510242891@lid',
        acceptedCharacterNames: ['Hyakuya Rokuhira'],
        result: 'reprovado',
    },
    {
        playerLabel: 'Juan — Kitou',
        characterLabel: 'Kael Vorn',
        playerId: '53288347144442@lid',
        acceptedCharacterNames: ['Kael Vorn'],
        result: 'reprovado',
    },
    {
        playerLabel: 'Rhyan',
        characterLabel: 'Renji',
        playerId: '252578604556502@lid',
        acceptedCharacterNames: ['Renji Feramena'],
        result: 'reprovado',
    },
    {
        playerLabel: 'João',
        characterLabel: 'Sieg',
        playerId: '51849415684125@lid',
        acceptedCharacterNames: ['Sieg Vermilion'],
        result: 'reprovado',
    },
    {
        playerLabel: 'Claucio',
        characterLabel: 'Amnos',
        playerId: '230828856610911@lid',
        acceptedCharacterNames: ['Amnos'],
        result: 'reprovado',
    },
    {
        playerLabel: 'Leonhardt Feramena',
        characterLabel: 'Leonhardt Feramena',
        playerId: '1649384923198@lid',
        acceptedCharacterNames: ['Leonhardt Feramena'],
        result: 'reprovado',
    },
    {
        playerLabel: 'Iori Mankoshoku',
        characterLabel: 'Iori Mankoshoku',
        playerId: '268804839972941@lid',
        acceptedCharacterNames: ['Iori Mankoshoku'],
        result: 'aprovado',
    },
];

function normalizeText(value) {
    return String(value ?? '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .toLowerCase();
}

function parseArguments(argv) {
    const apply = argv.includes('--apply');
    const explicitPreview = argv.includes('--preview');
    const confirmationArg = argv.find((arg) => arg.startsWith('--confirm='));
    const confirmation = confirmationArg
        ? confirmationArg.slice('--confirm='.length)
        : null;

    if (apply && explicitPreview) {
        throw new Error('Use apenas --preview ou --apply, nunca os dois juntos.');
    }

    if (apply && confirmation !== APPLY_CONFIRMATION) {
        throw new Error(
            `Aplicação bloqueada. Use --apply --confirm=${APPLY_CONFIRMATION}`
        );
    }

    return { mode: apply ? 'apply' : 'preview' };
}

async function tableExists(db, tableName) {
    const row = await db.get(
        `SELECT 1 AS found
         FROM sqlite_master
         WHERE type = 'table' AND name = ?`,
        [tableName]
    );
    return Boolean(row);
}

async function ensureCorrectionAuditSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_admission_exam_ph_corrections (
            event_key TEXT NOT NULL,
            player_id TEXT NOT NULL,
            player_label TEXT NOT NULL,
            character_label TEXT NOT NULL,
            exam_result TEXT NOT NULL,
            ph_amount INTEGER NOT NULL,
            ph_ledger_id INTEGER NOT NULL,
            snapshot_before_json TEXT NOT NULL,
            snapshot_after_json TEXT NOT NULL,
            applied_by TEXT NOT NULL,
            applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (event_key, player_id)
        );

        CREATE INDEX IF NOT EXISTS idx_admission_exam_ph_corrections_player
        ON clover_admission_exam_ph_corrections (player_id, applied_at);
    `);
}

async function getPlayerSnapshot(db, target) {
    const row = await db.get(
        `SELECT
             j.id,
             j.nome,
             j.personagem_nome,
             j.nome_real,
             j.display_name,
             j.canonical_player_id,
             j.merged_into,
             j.is_shadow,
             j.identity_status,
             j.lifecycle_status,
             j.jogo_status,
             s.ph_available,
             s.ph_accumulated
         FROM jogadores j
         LEFT JOIN clover_character_stats s
           ON s.player_id = j.id
         WHERE j.id = ?`,
        [target.playerId]
    );

    if (!row) return null;

    return {
        ...row,
        ph_available:
            row.ph_available === null || row.ph_available === undefined
                ? null
                : Number(row.ph_available),
        ph_accumulated:
            row.ph_accumulated === null || row.ph_accumulated === undefined
                ? null
                : Number(row.ph_accumulated),
    };
}

function validateIdentity(target, snapshot) {
    const problems = [];
    const warnings = [];

    if (!snapshot) {
        problems.push('jogador não encontrado');
        return { problems, warnings };
    }

    const actualNames = [snapshot.personagem_nome, snapshot.nome]
        .map(normalizeText)
        .filter(Boolean);
    const acceptedNames = target.acceptedCharacterNames
        .map(normalizeText)
        .filter(Boolean);

    if (!acceptedNames.some((name) => actualNames.includes(name))) {
        problems.push(
            `personagem divergente: banco="${snapshot.personagem_nome || snapshot.nome || '-'}"`
        );
    }

    if (snapshot.merged_into) {
        problems.push(`registro fundido em ${snapshot.merged_into}`);
    }

    if (Number(snapshot.is_shadow || 0) === 1) {
        problems.push('registro marcado como sombra');
    }

    if (
        snapshot.canonical_player_id &&
        snapshot.canonical_player_id !== snapshot.id
    ) {
        problems.push(
            `canonical_player_id aponta para ${snapshot.canonical_player_id}`
        );
    }

    if (normalizeText(snapshot.identity_status) === 'inactive') {
        problems.push('identidade inativa');
    }

    if (normalizeText(snapshot.jogo_status) !== 'liberado') {
        warnings.push(`jogo_status=${snapshot.jogo_status || 'null'}`);
    }

    if (normalizeText(snapshot.lifecycle_status) !== 'active') {
        warnings.push(`lifecycle_status=${snapshot.lifecycle_status || 'null'}`);
    }

    if (snapshot.ph_available === null || snapshot.ph_accumulated === null) {
        warnings.push('estado de PH ainda não inicializado');
    }

    return { problems, warnings };
}

async function getExistingCorrectionAudit(db, playerId) {
    if (!await tableExists(db, 'clover_admission_exam_ph_corrections')) {
        return null;
    }

    return db.get(
        `SELECT *
         FROM clover_admission_exam_ph_corrections
         WHERE event_key = ? AND player_id = ?`,
        [EVENT_KEY, playerId]
    );
}

async function getExistingPhEntries(db, playerId) {
    if (!await tableExists(db, 'clover_ph_ledger')) return [];

    const relatedId = `${EVENT_KEY}:${playerId}:ph`;

    return db.all(
        `SELECT id, player_id, amount, kind, source, reason, related_id,
                created_by, created_at, metadata_json
         FROM clover_ph_ledger
         WHERE player_id = ?
           AND ABS(COALESCE(amount, 0)) = ?
           AND kind IN ('ganho', 'ajuste_admin')
           AND (
                related_id = ?
                OR (
                    datetime(created_at) >= datetime('2026-07-30 00:00:00')
                    AND (
                        LOWER(COALESCE(source, '')) LIKE '%exame%admiss%'
                        OR LOWER(COALESCE(reason, '')) LIKE '%exame%admiss%'
                    )
                )
           )
         ORDER BY id ASC`,
        [playerId, PH_AMOUNT, relatedId]
    );
}

async function inspectTargets(db) {
    const rows = [];

    for (const target of TARGETS) {
        const snapshot = await getPlayerSnapshot(db, target);
        const validation = validateIdentity(target, snapshot);
        const existingAudit = await getExistingCorrectionAudit(db, target.playerId);
        const existingPhEntries = await getExistingPhEntries(db, target.playerId);

        const alreadyReceived = Boolean(existingAudit) || existingPhEntries.length > 0;
        const status = validation.problems.length
            ? 'BLOQUEADO'
            : alreadyReceived
                ? 'JÁ RECEBEU'
                : 'PENDENTE';

        rows.push({
            target,
            snapshot,
            problems: validation.problems,
            warnings: validation.warnings,
            existingAudit,
            existingPhEntries,
            alreadyReceived,
            status,
        });
    }

    return rows;
}

function printInspection(rows, mode) {
    console.log('============================================================');
    console.log('CORREÇÃO DE PH — PARTICIPANTES DO EXAME DE ADMISSÃO');
    console.log(`MODO: ${mode.toUpperCase()}`);
    console.log(`BANCO: ${DB_PATH}`);
    console.log(`EVENTO: ${EVENT_KEY}`);
    console.log(`ALVOS DESTA CORREÇÃO: ${TARGETS.length}`);
    console.log(`VALOR: +${PH_AMOUNT} PH por participante ainda pendente`);
    console.log('============================================================');

    for (const [index, row] of rows.entries()) {
        const { target, snapshot, problems, warnings, existingPhEntries, status } = row;

        console.log(
            `\n${String(index + 1).padStart(2, '0')}. [${status}] ` +
            `${target.playerLabel} | ${target.characterLabel}`
        );
        console.log(`    ID: ${target.playerId}`);
        console.log(`    Resultado: ${target.result}`);

        if (snapshot) {
            console.log(
                `    Banco: ${snapshot.personagem_nome || snapshot.nome || '-'} | ` +
                `PH ${snapshot.ph_available ?? '?'} disp. / ` +
                `${snapshot.ph_accumulated ?? '?'} acum.`
            );
        }

        if (existingPhEntries.length) {
            for (const entry of existingPhEntries) {
                console.log(
                    `    JÁ LANÇADO: ledger #${entry.id} | ` +
                    `${entry.kind} ${entry.amount} PH | ${entry.created_at}`
                );
            }
        }

        for (const problem of problems) {
            console.log(`    ERRO: ${problem}`);
        }

        for (const warning of warnings) {
            console.log(`    AVISO: ${warning}`);
        }
    }

    const blocked = rows.filter((row) => row.problems.length > 0);
    const already = rows.filter((row) => row.alreadyReceived);
    const pending = rows.filter(
        (row) => !row.alreadyReceived && row.problems.length === 0
    );

    console.log('\n============================================================');
    console.log(`JÁ RECEBERAM: ${already.length}`);
    console.log(`PENDENTES: ${pending.length}`);
    console.log(`BLOQUEADOS: ${blocked.length}`);
    console.log(`TOTAL A APLICAR: +${pending.length * PH_AMOUNT} PH`);

    if (blocked.length) {
        console.log('RESULTADO: BLOQUEADO. Nenhuma escrita deve ser realizada.');
    } else if (!pending.length) {
        console.log('RESULTADO: NENHUMA CORREÇÃO NECESSÁRIA.');
    } else {
        console.log('RESULTADO: PRÉ-VALIDAÇÃO APROVADA.');
    }

    console.log('============================================================');

    return { blocked, already, pending };
}

function timestampForFilename(date = new Date()) {
    const pad = (value) => String(value).padStart(2, '0');
    return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
        '-',
        pad(date.getHours()),
        pad(date.getMinutes()),
        pad(date.getSeconds()),
    ].join('');
}

function escapeSqlString(value) {
    return String(value).replace(/'/g, "''");
}

async function createConsistentBackup(db) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });

    const backupPath = path.join(
        BACKUP_DIR,
        `banco.before-admission-participants-${timestampForFilename()}.sqlite`
    );

    await db.exec(`VACUUM INTO '${escapeSqlString(backupPath)}'`);
    return backupPath;
}

async function insertCorrectionAudit(db, data) {
    await db.run(
        `INSERT INTO clover_admission_exam_ph_corrections (
            event_key,
            player_id,
            player_label,
            character_label,
            exam_result,
            ph_amount,
            ph_ledger_id,
            snapshot_before_json,
            snapshot_after_json,
            applied_by,
            applied_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [
            EVENT_KEY,
            data.target.playerId,
            data.target.playerLabel,
            data.target.characterLabel,
            data.target.result,
            PH_AMOUNT,
            data.ledgerId,
            JSON.stringify(data.before),
            JSON.stringify(data.after),
            ACTOR_ID,
        ]
    );
}

async function applyCorrections(db) {
    const initialRows = await inspectTargets(db);
    const initialSummary = printInspection(initialRows, 'apply-preflight');

    if (initialSummary.blocked.length) {
        throw new Error(
            `Aplicação recusada: ${initialSummary.blocked.length} alvo(s) bloqueado(s).`
        );
    }

    if (!initialSummary.pending.length) {
        return { backupPath: null, results: [], skipped: initialSummary.already };
    }

    const backupPath = await createConsistentBackup(db);
    console.log(`\nBACKUP CRIADO: ${backupPath}`);

    await db.exec('BEGIN IMMEDIATE');

    try {
        await ensureCorrectionAuditSchema(db);

        const lockedRows = await inspectTargets(db);
        const lockedBlocked = lockedRows.filter((row) => row.problems.length > 0);

        if (lockedBlocked.length) {
            throw new Error(
                `Identidade mudou durante a operação: ${lockedBlocked.length} alvo(s) bloqueado(s).`
            );
        }

        const results = [];
        const skipped = [];

        for (const row of lockedRows) {
            const { target } = row;

            if (row.alreadyReceived) {
                skipped.push(row);
                continue;
            }

            await ensurePhState(db, target.playerId);

            // Rechecagem dentro da mesma transação, imediatamente antes da escrita.
            const duplicateAudit = await getExistingCorrectionAudit(db, target.playerId);
            const duplicateLedger = await getExistingPhEntries(db, target.playerId);

            if (duplicateAudit || duplicateLedger.length) {
                skipped.push({
                    ...row,
                    alreadyReceived: true,
                    existingAudit: duplicateAudit,
                    existingPhEntries: duplicateLedger,
                });
                continue;
            }

            const before = await getPlayerSnapshot(db, target);
            const relatedId = `${EVENT_KEY}:${target.playerId}:ph`;

            const mutation = await addPhInTransaction(
                db,
                target.playerId,
                PH_AMOUNT,
                EVENT_SOURCE,
                EVENT_REASON,
                ACTOR_ID,
                {
                    event_key: EVENT_KEY,
                    event_type: 'admission_exam',
                    reward_basis: 'participation',
                    exam_result: target.result,
                    outside_weekly_limit: true,
                    bypass_weekly_limit: true,
                    correction_batch: true,
                    player_label: target.playerLabel,
                    character_label: target.characterLabel,
                },
                relatedId
            );

            const after = await getPlayerSnapshot(db, target);
            const availableDelta =
                Number(after.ph_available) - Number(before.ph_available);
            const accumulatedDelta =
                Number(after.ph_accumulated) - Number(before.ph_accumulated);

            if (availableDelta !== PH_AMOUNT || accumulatedDelta !== PH_AMOUNT) {
                throw new Error(
                    `${target.playerLabel}: delta inesperado de PH ` +
                    `(disponível ${availableDelta}; acumulado ${accumulatedDelta}).`
                );
            }

            const ledgerId = mutation?.ledgerId;
            if (!Number.isInteger(Number(ledgerId))) {
                throw new Error(`${target.playerLabel}: ledger de PH não retornou ID válido.`);
            }

            await insertCorrectionAudit(db, {
                target,
                ledgerId: Number(ledgerId),
                before,
                after,
            });

            results.push({
                target,
                before,
                after,
                ledgerId: Number(ledgerId),
            });
        }

        await db.exec('COMMIT');
        return { backupPath, results, skipped };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

function printApplied(result) {
    console.log('\n============================================================');
    console.log('CORREÇÃO CONCLUÍDA E COMMITADA');
    console.log('============================================================');

    if (result.backupPath) {
        console.log(`Backup: ${result.backupPath}`);
    }

    if (!result.results.length) {
        console.log('Nenhum novo lançamento foi necessário.');
    }

    for (const [index, item] of result.results.entries()) {
        console.log(
            `\n${String(index + 1).padStart(2, '0')}. ` +
            `${item.target.playerLabel} | ${item.target.characterLabel}`
        );
        console.log(`    ID: ${item.target.playerId}`);
        console.log(`    Ledger: #${item.ledgerId}`);
        console.log(
            `    PH disponível: ${item.before.ph_available} -> ${item.after.ph_available}`
        );
        console.log(
            `    PH acumulado: ${item.before.ph_accumulated} -> ${item.after.ph_accumulated}`
        );
    }

    console.log('\n============================================================');
    console.log(`NOVOS BENEFICIADOS: ${result.results.length}`);
    console.log(`JÁ RECOMPENSADOS/PULADOS: ${result.skipped.length}`);
    console.log(`TOTAL NOVO: +${result.results.length * PH_AMOUNT} PH`);
    console.log('============================================================');
}

async function main() {
    const { mode } = parseArguments(process.argv.slice(2));

    const db = await open({
        filename: DB_PATH,
        driver: sqlite3.Database,
    });

    db.configure?.('busyTimeout', 30000);

    await db.exec(`
        PRAGMA busy_timeout = 30000;
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
    `);

    try {
        if (mode === 'preview') {
            const rows = await inspectTargets(db);
            const summary = printInspection(rows, 'preview');
            console.log('\nNenhuma escrita foi realizada.');

            if (summary.blocked.length) {
                process.exitCode = 2;
            }
            return;
        }

        const result = await applyCorrections(db);
        printApplied(result);

        const verificationRows = await inspectTargets(db);
        const verification = printInspection(verificationRows, 'verificação-final');

        if (verification.blocked.length || verification.pending.length) {
            throw new Error(
                `Verificação final falhou: ${verification.blocked.length} bloqueado(s), ` +
                `${verification.pending.length} pendente(s).`
            );
        }
    } finally {
        await db.close();
    }
}

main().catch((error) => {
    console.error('\nFALHA:', error?.stack || error?.message || error);
    process.exitCode = 1;
});
