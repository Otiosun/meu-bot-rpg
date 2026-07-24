'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const { ensurePhState } = require('../helpers/clover/phService');
const { ensureYullsState } = require('../helpers/clover/yullsService');
const {
    NIGHTMARE_EVENT_KEY,
    NIGHTMARE_TITLE,
    applyNightmareRewardPackageInTransaction,
    ensureNightmareRewardInfrastructure,
} = require('../helpers/clover/nightmareEventRewardService');

const ROOT = path.resolve(__dirname, '..');
const DATABASE_PATH = path.join(ROOT, 'banco.sqlite');
const BACKUP_DIR = path.join(ROOT, 'backups');
const APPLY_CONFIRMATION = 'PESADELO-25';
const ACTOR_ID = 'system:evento_pesadelo';

const PACKAGES = Object.freeze({
    base: Object.freeze({
        yulls: 10000,
        ph: 60,
        rareBoxes: 1,
        commonBoxes: 1,
        spellTickets: 0,
        priorityCoupons: 0,
        provisionalBlackWands: 0,
    }),
    third: Object.freeze({
        yulls: 20000,
        ph: 80,
        rareBoxes: 2,
        commonBoxes: 2,
        spellTickets: 1,
        priorityCoupons: 1,
        provisionalBlackWands: 0,
    }),
    second: Object.freeze({
        yulls: 20000,
        ph: 100,
        rareBoxes: 3,
        commonBoxes: 3,
        spellTickets: 1,
        priorityCoupons: 1,
        provisionalBlackWands: 1,
    }),
    first: Object.freeze({
        yulls: 20000,
        ph: 100,
        rareBoxes: 3,
        commonBoxes: 3,
        spellTickets: 2,
        priorityCoupons: 1,
        provisionalBlackWands: 1,
    }),
});

const PLAYER_MANIFEST = Object.freeze([
    { playerName: 'Aurorita', characterName: 'Firefly', phone: '+55 92 9326-3023', packageKey: 'base' },
    { playerName: 'Kanon', characterName: 'Kame', phone: '+55 21 96587-0936', packageKey: 'third' },
    { playerName: 'Bithencourt', characterName: 'Haan', phone: '+55 51 9217-4801', packageKey: 'base' },
    { playerName: 'Belial', characterName: 'Kuutar', phone: '+55 11 97835-6754', packageKey: 'base' },
    { playerName: 'Carlos', characterName: 'Caelan', phone: '+55 13 97423-4936', packageKey: 'base' },
    { playerName: 'Vênus', characterName: 'Celeste', phone: '+55 81 9342-1445', packageKey: 'base' },
    { playerName: 'P', characterName: 'Kenny', phone: '+55 21 96593-9731', packageKey: 'base' },
    { playerName: 'Juan', characterName: 'Kael', phone: '+55 21 96510-4297', packageKey: 'base' },
    { playerName: 'T', characterName: 'Gohhan', phone: '+55 11 99381-1549', packageKey: 'base' },
    { playerName: 'Juan Lima', characterName: 'Minerva', phone: '+55 63 9286-7031', packageKey: 'base' },
    { playerName: 'Cauã', characterName: 'Finn', phone: '+55 12 98102-5200', packageKey: 'base' },
    { playerName: 'Rhyan', characterName: 'Renji', phone: '+55 49 8861-0995', packageKey: 'base' },
    { playerName: 'Paulin, o sumido', characterName: 'Drake', phone: '+55 79 8100-7324', packageKey: 'base' },
    { playerName: 'Haisen', characterName: 'Shinra', phone: '+55 85 92156-0915', packageKey: 'base' },
    { playerName: 'Goku Super Sayajin 100', characterName: 'Giyu', phone: '+55 17 99600-7398', packageKey: 'base' },
    { playerName: 'Nagatoro', characterName: 'Choso', phone: '+55 75 8114-0077', packageKey: 'base' },
    { playerName: 'Murilo', characterName: 'Daisuke', phone: '+55 51 8046-9185', packageKey: 'base' },
    { playerName: 'Alastor', characterName: 'Klaus', phone: '+244 951 532 202', packageKey: 'base' },
    { playerName: 'Polly', characterName: 'Aylin', phone: '+55 93 9104-7134', packageKey: 'first' },
    { playerName: 'Fernando', characterName: 'Leonhardt', phone: '+55 51 9472-9143', packageKey: 'second' },
    { playerName: 'Enzo', characterName: "Mugen'ya", phone: '+55 84 9919-9225', packageKey: 'base' },
    { playerName: 'Erick', characterName: 'Scarlett', phone: '+55 11 95731-6627', packageKey: 'base' },
    { playerName: 'Rhany', characterName: 'Elizabeth', phone: '+55 71 9328-0742', packageKey: 'base' },
    { playerName: 'Bruno', characterName: 'Jane Rip', phone: '+55 27 98846-4003', packageKey: 'base' },
    { playerName: 'Jasmim', characterName: 'Iori', phone: '+351 922 286 910', packageKey: 'base' },
]);

const EXPECTED_TOTALS = Object.freeze({
    players: 25,
    yulls: 280000,
    ph: 1600,
    rareBoxes: 30,
    commonBoxes: 30,
    titles: 25,
    spellTickets: 4,
    priorityCoupons: 3,
    provisionalBlackWands: 2,
});

function stamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function digits(value) {
    return String(value || '').replace(/\D/g, '');
}

function normalizeName(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function phoneVariants(value) {
    const original = digits(value);
    const variants = new Set(original ? [original] : []);
    if (original.startsWith('55')) {
        if (original.length === 12) {
            variants.add(`${original.slice(0, 4)}9${original.slice(4)}`);
        } else if (original.length === 13 && original[4] === '9') {
            variants.add(`${original.slice(0, 4)}${original.slice(5)}`);
        }
    }
    return [...variants];
}

function authInfoDirectories() {
    const directories = new Set();
    const addDirectory = (directory) => {
        if (directory && fs.existsSync(directory)) directories.add(directory);
    };

    addDirectory(path.join(ROOT, 'auth_info'));
    try {
        for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
            if (!entry.isDirectory() || !/auth/i.test(entry.name)) continue;
            const directory = path.join(ROOT, entry.name);
            addDirectory(directory);
            addDirectory(path.join(directory, 'auth_info'));
        }
    } catch {
        return [...directories];
    }
    return [...directories];
}

function parseMappedDigits(filePath, keys) {
    try {
        if (!fs.existsSync(filePath)) return '';
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (typeof parsed === 'string' || typeof parsed === 'number') return digits(parsed);
        if (parsed && typeof parsed === 'object') {
            for (const key of keys) {
                const mapped = digits(parsed[key]);
                if (mapped) return mapped;
            }
        }
    } catch {
        return '';
    }
    return '';
}

function mappedLidsForPhone(value) {
    const lids = new Set();
    for (const variant of phoneVariants(value)) {
        for (const directory of authInfoDirectories()) {
            const mapped = parseMappedDigits(
                path.join(directory, `lid-mapping-${variant}.json`),
                ['lid', 'lidJid', 'lid_jid', 'jid', 'id', 'user']
            );
            if (mapped) lids.add(mapped);
        }
    }
    return [...lids];
}

function calculateTotals(manifest = PLAYER_MANIFEST) {
    return manifest.reduce((total, entry) => {
        const rewardPackage = PACKAGES[entry.packageKey];
        total.players += 1;
        total.yulls += rewardPackage.yulls;
        total.ph += rewardPackage.ph;
        total.rareBoxes += rewardPackage.rareBoxes;
        total.commonBoxes += rewardPackage.commonBoxes;
        total.titles += 1;
        total.spellTickets += rewardPackage.spellTickets;
        total.priorityCoupons += rewardPackage.priorityCoupons;
        total.provisionalBlackWands += rewardPackage.provisionalBlackWands;
        return total;
    }, {
        players: 0,
        yulls: 0,
        ph: 0,
        rareBoxes: 0,
        commonBoxes: 0,
        titles: 0,
        spellTickets: 0,
        priorityCoupons: 0,
        provisionalBlackWands: 0,
    });
}

function validateManifest(manifest = PLAYER_MANIFEST) {
    const phones = new Set();
    for (const entry of manifest) {
        if (!PACKAGES[entry.packageKey]) throw new Error(`Pacote inválido para ${entry.characterName}: ${entry.packageKey}`);
        const phoneDigits = digits(entry.phone);
        if (phoneDigits.length < 8) throw new Error(`Telefone inválido para ${entry.characterName}: ${entry.phone}`);
        if (phones.has(phoneDigits)) throw new Error(`Telefone duplicado no manifesto: ${entry.phone}`);
        phones.add(phoneDigits);
    }
    const totals = calculateTotals(manifest);
    for (const [field, expected] of Object.entries(EXPECTED_TOTALS)) {
        if (totals[field] !== expected) {
            throw new Error(`Total inválido em ${field}: esperado ${expected}, encontrado ${totals[field]}`);
        }
    }
    return totals;
}

async function tableExists(db, tableName) {
    return Boolean(await db.get(
        `SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?`,
        [tableName]
    ));
}

async function getPlayerById(db, playerId) {
    return db.get('SELECT * FROM jogadores WHERE id = ?', [playerId]);
}

async function resolveCanonicalReadOnly(db, player) {
    let current = player;
    const visited = new Set();
    while (current?.id && !visited.has(current.id)) {
        visited.add(current.id);
        const destination = String(current.merged_into || current.canonical_player_id || '').trim();
        if (!destination || destination === current.id) break;
        const next = await getPlayerById(db, destination);
        if (!next) break;
        current = next;
    }
    return current;
}

function playerHasExactCharacter(player, expectedCharacter) {
    return [player?.personagem_nome, player?.display_name, player?.nome]
        .map(normalizeName)
        .filter(Boolean)
        .includes(expectedCharacter);
}

async function canonicalizeCandidates(db, candidateSources) {
    const canonical = new Map();
    for (const [candidateId, sources] of candidateSources.entries()) {
        const raw = await getPlayerById(db, candidateId);
        const resolved = await resolveCanonicalReadOnly(db, raw);
        if (!resolved?.id) continue;
        const existing = canonical.get(resolved.id) || { player: resolved, sources: new Set() };
        for (const source of sources) existing.sources.add(source);
        canonical.set(resolved.id, existing);
    }
    return canonical;
}

async function resolvePlayerReadOnly(db, entry) {
    const expectedCharacter = normalizeName(entry.characterName);
    const variants = phoneVariants(entry.phone);
    const variantSet = new Set(variants);
    const mappedLids = mappedLidsForPhone(entry.phone);
    const mappedLidSet = new Set(mappedLids);
    const candidateSources = new Map();
    const players = await db.all('SELECT * FROM jogadores WHERE id IS NOT NULL');

    const addCandidate = (playerId, source) => {
        const id = String(playerId || '').trim();
        if (!id) return;
        const sources = candidateSources.get(id) || new Set();
        sources.add(source);
        candidateSources.set(id, sources);
    };

    for (const player of players) {
        const playerDigits = digits(player.id);
        if (variantSet.has(playerDigits)) addCandidate(player.id, 'telefone_direto');
        if (mappedLidSet.has(playerDigits)) addCandidate(player.id, 'mapeamento_lid');
    }

    if (await tableExists(db, 'clover_player_aliases')) {
        for (const variant of variants) {
            const aliases = await db.all(
                `SELECT player_id_destino
                 FROM clover_player_aliases
                 WHERE active = 1 AND alias_type = 'phone' AND alias_value = ?`,
                [variant]
            );
            aliases.forEach((row) => addCandidate(row.player_id_destino, 'alias_telefone'));
        }
    }

    if (await tableExists(db, 'clover_player_target_aliases')) {
        for (const variant of variants) {
            const aliases = await db.all(
                `SELECT player_id
                 FROM clover_player_target_aliases
                 WHERE alias_key = ?`,
                [`phone:${variant}`]
            );
            aliases.forEach((row) => addCandidate(row.player_id, 'alias_legado_telefone'));
        }
    }

    for (const lid of mappedLids) {
        const exactLid = await getPlayerById(db, `${lid}@lid`);
        if (exactLid) addCandidate(exactLid.id, 'mapeamento_lid');
    }

    const phoneCanonical = await canonicalizeCandidates(db, candidateSources);
    const matchingPhoneCandidates = [...phoneCanonical.values()]
        .filter((candidate) => playerHasExactCharacter(candidate.player, expectedCharacter));

    let selected;
    let resolutionSource;
    if (matchingPhoneCandidates.length === 1) {
        selected = matchingPhoneCandidates[0].player;
        resolutionSource = [...matchingPhoneCandidates[0].sources].sort().join('+');
    } else if (matchingPhoneCandidates.length > 1) {
        throw new Error(
            `Telefone de ${entry.playerName}/${entry.characterName} resolveu para `
            + `${matchingPhoneCandidates.length} cadastros canônicos com o mesmo personagem.`
        );
    } else if (phoneCanonical.size > 0) {
        const names = [...phoneCanonical.values()]
            .map((candidate) => candidate.player.personagem_nome || candidate.player.display_name || candidate.player.nome || candidate.player.id)
            .join(', ');
        throw new Error(
            `Telefone de ${entry.playerName}/${entry.characterName} resolveu para outro(s) personagem(ns): ${names}.`
        );
    } else {
        const characterCanonical = new Map();
        for (const player of players.filter((candidate) => playerHasExactCharacter(candidate, expectedCharacter))) {
            const resolved = await resolveCanonicalReadOnly(db, player);
            if (resolved?.id && playerHasExactCharacter(resolved, expectedCharacter)) {
                characterCanonical.set(resolved.id, resolved);
            }
        }
        if (characterCanonical.size !== 1) {
            throw new Error(
                `Falha ao resolver ${entry.playerName}/${entry.characterName} (${entry.phone}): `
                + `nenhum telefone compatível e ${characterCanonical.size} cadastro(s) canônico(s) por personagem exato.`
            );
        }
        selected = [...characterCanonical.values()][0];
        resolutionSource = 'personagem_exato_unico';
    }

    return {
        ...entry,
        phoneDigits: digits(entry.phone),
        phoneVariants: variants,
        mappedLids,
        playerId: selected.id,
        resolvedCharacterName: selected.personagem_nome || selected.display_name || selected.nome,
        resolutionSource,
        gameStatus: selected.jogo_status || null,
        lifecycleStatus: selected.lifecycle_status || null,
        rewardPackage: PACKAGES[entry.packageKey],
    };
}

async function resolveManifestReadOnly(db, manifest = PLAYER_MANIFEST) {
    const resolved = [];
    const playerIds = new Set();
    for (const entry of manifest) {
        const target = await resolvePlayerReadOnly(db, entry);
        if (playerIds.has(target.playerId)) {
            throw new Error(`Dois registros do manifesto resolveram para o mesmo player: ${target.playerId}`);
        }
        playerIds.add(target.playerId);
        resolved.push(target);
    }
    return resolved;
}

function checkBotHealth() {
    return new Promise((resolve) => {
        const request = http.get('http://127.0.0.1:8787/health', { timeout: 800 }, (response) => {
            response.resume();
            resolve(response.statusCode === 200);
        });
        request.on('timeout', () => {
            request.destroy();
            resolve(false);
        });
        request.on('error', () => resolve(false));
    });
}

async function checkpointDatabase() {
    const db = await open({ filename: DATABASE_PATH, driver: sqlite3.Database });
    try {
        await db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
        await db.close();
    }
}

function createBackup(runStamp) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const backupPath = path.join(BACKUP_DIR, `before-nightmare-rewards-${runStamp}.sqlite`);
    fs.copyFileSync(DATABASE_PATH, backupPath);
    return backupPath;
}

function printTotals(totals, label = 'Totais') {
    console.log(`\n${label}:`);
    console.log(`- Jogadores: ${totals.players}`);
    console.log(`- Yulls: ${totals.yulls.toLocaleString('pt-BR')}`);
    console.log(`- PH: ${totals.ph.toLocaleString('pt-BR')}`);
    console.log(`- Caixas Raras: ${totals.rareBoxes}`);
    console.log(`- Caixas Comuns: ${totals.commonBoxes}`);
    console.log(`- Títulos: ${totals.titles}`);
    console.log(`- Tickets de Feitiço: ${totals.spellTickets}`);
    console.log(`- Cupons de Prioridade: ${totals.priorityCoupons}`);
    console.log(`- Varetas Negras provisórias: ${totals.provisionalBlackWands}`);
}

function printResolved(resolved) {
    console.log('\nCadastros resolvidos:');
    for (const [index, entry] of resolved.entries()) {
        const podium = entry.packageKey === 'base' ? 'base' : `${entry.packageKey} place`;
        console.log(
            `${String(index + 1).padStart(2, '0')}. ${entry.playerName} / ${entry.resolvedCharacterName} `
            + `— ${entry.phone} — ${podium} — ${entry.playerId} — via ${entry.resolutionSource}`
        );
    }
    const fallback = resolved.filter((entry) => entry.resolutionSource === 'personagem_exato_unico');
    if (fallback.length) {
        console.log(`\nAtenção: ${fallback.length} cadastro(s) foram resolvidos por personagem exato e único, sem vínculo telefônico local disponível:`);
        for (const entry of fallback) console.log(`- ${entry.playerName} / ${entry.resolvedCharacterName}`);
    }
}

async function auditAppliedTotals(db) {
    const yulls = await db.get(
        `SELECT COUNT(*) AS entries, COALESCE(SUM(amount), 0) AS total
         FROM clover_yulls_ledger
         WHERE idempotency_key LIKE ?`,
        [`${NIGHTMARE_EVENT_KEY}:%:yulls`]
    );
    const ph = await db.get(
        `SELECT COUNT(*) AS entries, COALESCE(SUM(amount), 0) AS total
         FROM clover_ph_ledger
         WHERE source = 'evento_pesadelo' AND related_id LIKE ?`,
        [`${NIGHTMARE_EVENT_KEY}:%:ph`]
    );
    const itemRows = await db.all(
        `SELECT idempotency_key, COALESCE(SUM(CASE WHEN quantity_delta > 0 THEN quantity_delta ELSE 0 END), 0) AS total
         FROM clover_inventory_item_history
         WHERE idempotency_key LIKE ?
         GROUP BY idempotency_key`,
        [`${NIGHTMARE_EVENT_KEY}:%`]
    );
    const itemTotals = {
        rareBoxes: 0,
        commonBoxes: 0,
        spellTickets: 0,
        priorityCoupons: 0,
        provisionalBlackWands: 0,
    };
    for (const row of itemRows) {
        const key = String(row.idempotency_key || '');
        const amount = Number(row.total || 0);
        if (key.endsWith(':caixas_raras')) itemTotals.rareBoxes += amount;
        else if (key.endsWith(':caixas_comuns')) itemTotals.commonBoxes += amount;
        else if (key.endsWith(':tickets_feitico')) itemTotals.spellTickets += amount;
        else if (key.endsWith(':cupons_prioridade')) itemTotals.priorityCoupons += amount;
        else if (key.endsWith(':varetas_negras_provisorias')) itemTotals.provisionalBlackWands += amount;
    }
    const titles = await db.get(
        `SELECT COUNT(*) AS total FROM clover_player_titles WHERE title_key = ?`,
        [NIGHTMARE_TITLE.key]
    );
    return {
        players: Number(yulls.entries || 0),
        yulls: Number(yulls.total || 0),
        ph: Number(ph.total || 0),
        rareBoxes: itemTotals.rareBoxes,
        commonBoxes: itemTotals.commonBoxes,
        titles: Number(titles.total || 0),
        spellTickets: itemTotals.spellTickets,
        priorityCoupons: itemTotals.priorityCoupons,
        provisionalBlackWands: itemTotals.provisionalBlackWands,
    };
}

function assertTotals(actual, expected = EXPECTED_TOTALS) {
    for (const [field, value] of Object.entries(expected)) {
        if (actual[field] !== value) {
            throw new Error(`Auditoria final falhou em ${field}: esperado ${value}, encontrado ${actual[field]}`);
        }
    }
}

async function applyRewards(db, resolved) {
    await ensureNightmareRewardInfrastructure(db);
    for (const entry of resolved) {
        await ensurePhState(db, entry.playerId);
        await ensureYullsState(db, entry.playerId);
    }

    const results = [];
    await db.exec('BEGIN IMMEDIATE');
    try {
        for (const entry of resolved) {
            results.push({
                playerName: entry.playerName,
                characterName: entry.resolvedCharacterName,
                packageKey: entry.packageKey,
                result: await applyNightmareRewardPackageInTransaction(
                    db,
                    entry.playerId,
                    entry.rewardPackage,
                    ACTOR_ID
                ),
            });
        }
        await db.exec('COMMIT');
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
    return results;
}

async function main() {
    const apply = process.argv.includes('--apply');
    const confirmation = process.argv.find((argument) => argument.startsWith('--confirm='))?.split('=')[1] || '';
    const expected = validateManifest();

    console.log('\n=== PREMIAÇÃO DO EVENTO PESADELO ===');
    console.log(`Modo: ${apply ? 'APLICAÇÃO CONTROLADA' : 'SIMULAÇÃO SOMENTE LEITURA'}`);
    console.log('Saga narrada: fora da automação');
    console.log(`Título: ${NIGHTMARE_TITLE.name} para os 25`);
    printTotals(expected, 'Matriz fechada');

    if (!fs.existsSync(DATABASE_PATH)) throw new Error(`Banco não encontrado: ${DATABASE_PATH}`);
    if (apply && confirmation !== APPLY_CONFIRMATION) {
        throw new Error(`Confirmação inválida. Use --confirm=${APPLY_CONFIRMATION}`);
    }
    if (apply && await checkBotHealth()) {
        throw new Error('O Clover ainda está online na porta 8787. Pare somente o PM2 ID 1 antes de aplicar.');
    }

    let backupPath = null;
    const runStamp = stamp();
    if (apply) {
        await checkpointDatabase();
        backupPath = createBackup(runStamp);
        console.log(`\nBackup criado: ${backupPath}`);
    }

    const db = await open({ filename: DATABASE_PATH, driver: sqlite3.Database });
    try {
        const resolved = await resolveManifestReadOnly(db);
        printResolved(resolved);

        if (!apply) {
            console.log('\nSIMULAÇÃO CONCLUÍDA. Nenhuma premiação foi gravada.');
            console.log('Para aplicar: npm run apply:nightmare-rewards');
            return;
        }

        const results = await applyRewards(db, resolved);
        const appliedTotals = await auditAppliedTotals(db);
        assertTotals(appliedTotals);
        const integrity = await db.get('PRAGMA integrity_check');
        const integrityValue = integrity?.integrity_check || Object.values(integrity || {})[0];
        if (integrityValue !== 'ok') throw new Error(`SQLite integrity_check: ${integrityValue || 'resultado ausente'}`);

        const reportPath = path.join(BACKUP_DIR, `nightmare-rewards-${runStamp}.json`);
        const report = {
            ok: true,
            generatedAt: new Date().toISOString(),
            eventKey: NIGHTMARE_EVENT_KEY,
            database: DATABASE_PATH,
            backup: backupPath,
            expectedTotals: expected,
            appliedTotals,
            title: NIGHTMARE_TITLE,
            sagaNarratedAutomated: false,
            resolvedPlayers: resolved.map((entry) => ({
                playerName: entry.playerName,
                characterName: entry.resolvedCharacterName,
                phone: entry.phone,
                playerId: entry.playerId,
                packageKey: entry.packageKey,
                resolutionSource: entry.resolutionSource,
            })),
            results,
            integrityCheck: integrityValue,
        };
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

        printTotals(appliedTotals, 'Auditoria final');
        console.log(`\nRelatório: ${reportPath}`);
        console.log('SQLite: íntegro');
        console.log('\n=== PREMIAÇÃO APLICADA SEM DUPLICAÇÃO ===');
    } finally {
        await db.close();
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error('\nFALHA NA PREMIAÇÃO:');
        console.error(error.stack || error.message || error);
        process.exitCode = 1;
    });
}

module.exports = {
    APPLY_CONFIRMATION,
    EXPECTED_TOTALS,
    PACKAGES,
    PLAYER_MANIFEST,
    calculateTotals,
    mappedLidsForPhone,
    phoneVariants,
    validateManifest,
};
