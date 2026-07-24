'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    PLAYER_MANIFEST,
    phoneVariants,
    mappedLidsForPhone,
} = require('./applyNightmareEventRewards');
const { NIGHTMARE_EVENT_KEY } = require('../helpers/clover/nightmareEventRewardService');

const ROOT = path.resolve(__dirname, '..');
const DATABASE_PATH = path.join(ROOT, 'banco.sqlite');
const BACKUP_DIR = path.join(ROOT, 'backups');
const TARGET_MAP_PATH = path.join(BACKUP_DIR, 'nightmare-target-map.json');

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

function isPlaceholderName(value) {
    const normalized = normalizeName(value);
    return !normalized || new Set([
        '-', 'na', 'n a', 'nenhum', 'nenhuma', 'sem personagem', 'sem nome', 'vazio',
    ]).has(normalized);
}

function characterNameOf(player) {
    const value = String(player?.personagem_nome || '').trim();
    return isPlaceholderName(value) ? '' : value;
}

function phoneConfirmedNameMatch(actual, expected) {
    const left = normalizeName(actual);
    const right = normalizeName(expected);
    if (!left || !right) return false;
    return left === right || left.startsWith(`${right} `) || right.startsWith(`${left} `);
}

function fallbackNameMatch(actual, expected) {
    const left = normalizeName(actual);
    const right = normalizeName(expected);
    if (!left || !right) return false;
    return left === right || left.startsWith(`${right} `);
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

function addCandidate(candidateSources, playerId, source) {
    const id = String(playerId || '').trim();
    if (!id) return;
    const sources = candidateSources.get(id) || new Set();
    sources.add(source);
    candidateSources.set(id, sources);
}

async function canonicalizeCandidates(db, candidateSources) {
    const canonical = new Map();
    for (const [candidateId, sources] of candidateSources.entries()) {
        const raw = await getPlayerById(db, candidateId);
        const resolved = await resolveCanonicalReadOnly(db, raw);
        if (!resolved?.id) continue;
        const existing = canonical.get(resolved.id) || { player: resolved, sources: new Set(), rawIds: new Set() };
        sources.forEach((source) => existing.sources.add(source));
        existing.rawIds.add(candidateId);
        canonical.set(resolved.id, existing);
    }
    return canonical;
}

async function resolveEntry(db, players, entry) {
    const variants = phoneVariants(entry.phone);
    const variantSet = new Set(variants);
    const mappedLids = mappedLidsForPhone(entry.phone);
    const mappedLidSet = new Set(mappedLids);
    const candidateSources = new Map();

    for (const player of players) {
        const idDigits = digits(player.id);
        if (variantSet.has(idDigits)) addCandidate(candidateSources, player.id, 'telefone_direto');
        if (mappedLidSet.has(idDigits)) addCandidate(candidateSources, player.id, 'mapeamento_lid');
    }

    if (await tableExists(db, 'clover_player_aliases')) {
        for (const variant of variants) {
            const aliases = await db.all(
                `SELECT player_id_destino FROM clover_player_aliases
                 WHERE active = 1 AND alias_type = 'phone' AND alias_value = ?`,
                [variant]
            );
            aliases.forEach((row) => addCandidate(candidateSources, row.player_id_destino, 'alias_telefone'));
        }
    }

    if (await tableExists(db, 'clover_player_target_aliases')) {
        for (const variant of variants) {
            const aliases = await db.all(
                `SELECT player_id FROM clover_player_target_aliases WHERE alias_key = ?`,
                [`phone:${variant}`]
            );
            aliases.forEach((row) => addCandidate(candidateSources, row.player_id, 'alias_legado_telefone'));
        }
    }

    for (const lid of mappedLids) {
        const exact = await getPlayerById(db, `${lid}@lid`);
        if (exact) addCandidate(candidateSources, exact.id, 'mapeamento_lid');
    }

    const phoneCanonical = await canonicalizeCandidates(db, candidateSources);
    const phoneCandidates = [...phoneCanonical.values()].map((candidate) => ({
        playerId: candidate.player.id,
        characterName: characterNameOf(candidate.player),
        playerName: String(candidate.player.nome || ''),
        displayName: String(candidate.player.display_name || ''),
        sources: [...candidate.sources].sort(),
        rawIds: [...candidate.rawIds].sort(),
    }));
    const meaningful = phoneCandidates.filter((candidate) => candidate.characterName);
    const matching = meaningful.filter((candidate) => phoneConfirmedNameMatch(candidate.characterName, entry.characterName));
    const conflicting = meaningful.filter((candidate) => !phoneConfirmedNameMatch(candidate.characterName, entry.characterName));
    const ignoredEmpty = phoneCandidates.filter((candidate) => !candidate.characterName);

    let selected = null;
    let status = 'review';
    let reason = '';

    if (matching.length === 1 && conflicting.length === 0) {
        selected = matching[0];
        status = 'ok';
        reason = ignoredEmpty.length ? `telefone confirmado; ${ignoredEmpty.length} cadastro(s) vazio(s) ignorado(s)` : 'telefone confirmado';
    } else if (matching.length > 1) {
        reason = `${matching.length} cadastros canônicos compatíveis pelo telefone`;
    } else if (matching.length === 1 && conflicting.length > 0) {
        reason = `telefone também ligado a personagem real diferente: ${conflicting.map((item) => item.characterName).join(', ')}`;
    } else if (meaningful.length > 0) {
        reason = `telefone ligado a outro(s) personagem(ns): ${meaningful.map((item) => item.characterName).join(', ')}`;
    } else {
        const fallbackCanonical = new Map();
        for (const player of players) {
            const actual = characterNameOf(player);
            if (!actual || !fallbackNameMatch(actual, entry.characterName)) continue;
            const resolved = await resolveCanonicalReadOnly(db, player);
            const resolvedName = characterNameOf(resolved);
            if (resolved?.id && resolvedName && fallbackNameMatch(resolvedName, entry.characterName)) {
                fallbackCanonical.set(resolved.id, {
                    playerId: resolved.id,
                    characterName: resolvedName,
                    playerName: String(resolved.nome || ''),
                    displayName: String(resolved.display_name || ''),
                    sources: ['personagem_unico'],
                    rawIds: [player.id],
                });
            }
        }
        if (fallbackCanonical.size === 1) {
            selected = [...fallbackCanonical.values()][0];
            status = 'ok';
            reason = 'personagem único; nenhum vínculo telefônico local';
        } else {
            reason = `nenhum telefone útil e ${fallbackCanonical.size} candidato(s) por personagem`;
        }
    }

    return {
        ...entry,
        status,
        reason,
        selected,
        phoneVariants: variants,
        mappedLids,
        phoneCandidates,
        ignoredEmptyCount: ignoredEmpty.length,
    };
}

async function main() {
    console.log('\n=== AUDITORIA COMPLETA DOS 25 ALVOS ===');
    console.log('Modo: SOMENTE LEITURA DO BANCO');

    if (!fs.existsSync(DATABASE_PATH)) throw new Error(`Banco não encontrado: ${DATABASE_PATH}`);
    const db = await open({ filename: DATABASE_PATH, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
    try {
        const players = await db.all('SELECT * FROM jogadores WHERE id IS NOT NULL');
        const results = [];
        for (const entry of PLAYER_MANIFEST) results.push(await resolveEntry(db, players, entry));

        const idOwners = new Map();
        for (const result of results.filter((item) => item.status === 'ok')) {
            const owners = idOwners.get(result.selected.playerId) || [];
            owners.push(result);
            idOwners.set(result.selected.playerId, owners);
        }
        for (const owners of idOwners.values()) {
            if (owners.length < 2) continue;
            for (const result of owners) {
                result.status = 'review';
                result.reason = `ID canônico repetido em ${owners.length} entradas do manifesto`;
            }
        }

        for (const [index, result] of results.entries()) {
            const prefix = result.status === 'ok' ? 'OK    ' : 'REVISAR';
            if (result.status === 'ok') {
                console.log(
                    `${prefix} ${String(index + 1).padStart(2, '0')}. ${result.playerName}/${result.characterName}`
                    + ` -> ${result.selected.characterName} [${result.selected.playerId}]`
                    + ` via ${result.selected.sources.join('+')} · ${result.reason}`
                );
            } else {
                console.log(`${prefix} ${String(index + 1).padStart(2, '0')}. ${result.playerName}/${result.characterName} · ${result.reason}`);
                for (const candidate of result.phoneCandidates) {
                    console.log(
                        `       candidato: ${candidate.characterName || '(vazio)'} [${candidate.playerId}]`
                        + ` · jogador=${candidate.playerName || '-'} · display=${candidate.displayName || '-'}`
                        + ` · via=${candidate.sources.join('+')}`
                    );
                }
            }
        }

        fs.mkdirSync(BACKUP_DIR, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const reportPath = path.join(BACKUP_DIR, `nightmare-target-audit-${stamp}.json`);
        fs.writeFileSync(reportPath, JSON.stringify({
            generatedAt: new Date().toISOString(),
            eventKey: NIGHTMARE_EVENT_KEY,
            results,
        }, null, 2), 'utf8');

        const unresolved = results.filter((item) => item.status !== 'ok');
        if (unresolved.length) {
            console.log(`\nResultado: ${results.length - unresolved.length}/25 resolvidos; ${unresolved.length} precisam de revisão.`);
            console.log(`Relatório completo: ${reportPath}`);
            process.exitCode = 1;
            return;
        }

        const targetMap = {
            generatedAt: new Date().toISOString(),
            eventKey: NIGHTMARE_EVENT_KEY,
            entries: results.map((result) => ({
                playerName: result.playerName,
                characterName: result.characterName,
                phone: result.phone,
                packageKey: result.packageKey,
                playerId: result.selected.playerId,
                resolvedCharacterName: result.selected.characterName,
                resolutionSource: result.selected.sources.join('+'),
            })),
        };
        fs.writeFileSync(TARGET_MAP_PATH, JSON.stringify(targetMap, null, 2), 'utf8');

        console.log('\nResultado: 25/25 resolvidos, IDs canônicos únicos.');
        console.log(`Mapa fixo criado: ${TARGET_MAP_PATH}`);
        console.log(`Relatório completo: ${reportPath}`);
        console.log('Nenhuma recompensa foi aplicada.');
    } finally {
        await db.close();
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error('\nFALHA NA AUDITORIA DOS ALVOS:');
        console.error(error.stack || error.message || error);
        process.exitCode = 1;
    });
}

module.exports = {
    characterNameOf,
    fallbackNameMatch,
    isPlaceholderName,
    normalizeName,
    phoneConfirmedNameMatch,
};
