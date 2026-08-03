'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'banco.sqlite');
const AUTH_INFO_DIR = path.join(ROOT, 'auth_info');

function normalizeText(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

function normalizeJid(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return '';
    const match = raw.match(/(\d{8,})@(lid|s\.whatsapp\.net)/);
    return match ? `${match[1]}@${match[2]}` : raw;
}

function extractDigits(value) {
    return String(value || '').replace(/\D/g, '');
}

function playerName(player = {}) {
    return [player.personagem_nome, player.display_name, player.nome, player.nome_real]
        .map((value) => String(value || '').trim())
        .find((value) => value && value !== '-') || '(sem nome)';
}

function isApproved(value) {
    return ['aprovada', 'aprovado', 'confirmada', 'confirmado'].includes(normalizeText(value));
}

function isRejected(value) {
    return ['negada', 'rejeitada', 'reprovada', 'rejected'].includes(normalizeText(value));
}

function canPlay(player = {}) {
    return isApproved(player.ficha_status)
        && !isRejected(player.historia_status)
        && normalizeText(player.jogo_status) === 'liberado';
}

function isActive(player = {}) {
    return normalizeText(player.identity_status || 'active') === 'active'
        && normalizeText(player.lifecycle_status || 'active') === 'active'
        && Number(player.is_shadow || 0) === 0
        && !player.merged_into;
}

function hasValue(value) {
    const text = String(value || '').trim();
    return Boolean(text) && text !== '-';
}

function scorePlayer(player = {}) {
    let score = 0;
    if (canPlay(player)) score += 10000;
    if (isApproved(player.ficha_status)) score += 1000;
    if (['approved', 'aprovada', 'aprovado'].includes(normalizeText(player.personagem_aparencia_status))) score += 500;
    if (['approved', 'aprovada', 'aprovado'].includes(normalizeText(player.historia_status))) score += 500;
    if (normalizeText(player.distribution_status) === 'confirmed') score += 250;
    if (isActive(player)) score += 100;
    for (const key of ['personagem_nome', 'nome', 'raca', 'classe', 'grimorio', 'magia']) {
        if (hasValue(player[key])) score += 25;
    }
    if (normalizeText(player.personagem_nome) === 'cacador') score -= 500;
    if (normalizeText(player.nome) === 'cacador') score -= 250;
    return score;
}

function addEdge(graph, left, right) {
    const a = normalizeJid(left);
    const b = normalizeJid(right);
    if (!a || !b || a === b) return;
    if (!graph.has(a)) graph.set(a, new Set());
    if (!graph.has(b)) graph.set(b, new Set());
    graph.get(a).add(b);
    graph.get(b).add(a);
}

function inferDomain(keyHint, fallbackDomain) {
    const key = String(keyHint || '').toLowerCase();
    if (key.includes('phone') || key === 'pn' || key.includes('phone_number')) return 's.whatsapp.net';
    if (key.includes('lid')) return 'lid';
    return fallbackDomain;
}

function candidateFromScalar(value, keyHint, fallbackDomain) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const explicit = raw.match(/(\d{8,})@(lid|s\.whatsapp\.net)/i);
    if (explicit) return `${explicit[1]}@${explicit[2].toLowerCase()}`;
    const digits = extractDigits(raw);
    if (digits.length < 8) return '';
    const domain = inferDomain(keyHint, fallbackDomain);
    return domain ? `${digits}@${domain}` : '';
}

function collectCandidates(value, fallbackDomain, output, keyHint = '') {
    if (value === null || value === undefined) return;
    if (typeof value === 'string' || typeof value === 'number') {
        const candidate = candidateFromScalar(value, keyHint, fallbackDomain);
        if (candidate) output.add(candidate);
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectCandidates(item, fallbackDomain, output, keyHint);
        return;
    }
    if (typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) {
            collectCandidates(item, inferDomain(key, fallbackDomain), output, key);
        }
    }
}

function buildAuthGraph() {
    const graph = new Map();
    if (!fs.existsSync(AUTH_INFO_DIR)) return graph;

    const files = fs.readdirSync(AUTH_INFO_DIR)
        .filter((name) => /^lid-mapping-\d+(?:_reverse)?\.json$/i.test(name));

    for (const name of files) {
        const match = name.match(/^lid-mapping-(\d+)(_reverse)?\.json$/i);
        if (!match) continue;
        const reverse = Boolean(match[2]);
        const root = `${match[1]}@${reverse ? 'lid' : 's.whatsapp.net'}`;
        const fallbackDomain = reverse ? 's.whatsapp.net' : 'lid';
        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(path.join(AUTH_INFO_DIR, name), 'utf8'));
        } catch {
            continue;
        }
        const candidates = new Set();
        collectCandidates(parsed, fallbackDomain, candidates);
        for (const candidate of candidates) addEdge(graph, root, candidate);
    }

    return graph;
}

function connectedNodes(graph, seeds) {
    const queue = [...new Set(seeds.map(normalizeJid).filter(Boolean))];
    const visited = new Set(queue);
    while (queue.length) {
        const current = queue.shift();
        for (const next of graph.get(current) || []) {
            if (visited.has(next)) continue;
            visited.add(next);
            queue.push(next);
        }
    }
    return visited;
}

async function tableColumns(db, tableName) {
    const exists = await db.get(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?",
        [tableName]
    );
    if (!exists) return new Set();
    const rows = await db.all(`PRAGMA table_info(${JSON.stringify(tableName)})`);
    return new Set(rows.map((row) => row.name));
}

async function main() {
    if (!fs.existsSync(DB_PATH)) throw new Error(`Banco nao encontrado: ${DB_PATH}`);

    const db = await open({
        filename: DB_PATH,
        driver: sqlite3.Database,
        mode: sqlite3.OPEN_READONLY,
    });

    try {
        await db.exec('PRAGMA query_only = ON');
        await db.exec('PRAGMA busy_timeout = 10000');

        const playerColumns = await tableColumns(db, 'jogadores');
        const hasStats = await db.get(
            "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'clover_character_stats'"
        );
        const statsJoin = hasStats
            ? 'LEFT JOIN clover_character_stats s ON s.player_id = j.id'
            : '';
        const statsSelect = hasStats ? ', s.distribution_status' : ', NULL AS distribution_status';

        const players = await db.all(
            `SELECT j.* ${statsSelect}
             FROM jogadores j
             ${statsJoin}`
        );
        const playersById = new Map(players.map((player) => [normalizeJid(player.id), player]));

        const sessions = await db.all(
            `SELECT s.token_hash,
                    s.player_id,
                    s.phone_digits,
                    s.created_at,
                    s.last_seen_at,
                    s.expires_at,
                    j.personagem_nome,
                    j.nome,
                    j.ficha_status,
                    j.personagem_aparencia_status,
                    j.historia_status,
                    j.jogo_status
             FROM clover_site_sessions s
             LEFT JOIN jogadores j ON j.id = s.player_id
             WHERE s.revoked_at IS NULL
               AND datetime(s.expires_at) > datetime('now')
             ORDER BY s.last_seen_at DESC, s.created_at DESC`
        );

        const graph = buildAuthGraph();
        for (const session of sessions) {
            const phone = extractDigits(session.phone_digits);
            if (phone) addEdge(graph, session.player_id, `${phone}@s.whatsapp.net`);
        }

        if (playerColumns.has('merged_into')) {
            for (const player of players) {
                if (player.merged_into) addEdge(graph, player.id, player.merged_into);
            }
        }

        const blockedSessions = sessions.filter((session) => {
            const player = playersById.get(normalizeJid(session.player_id));
            return !player || !canPlay(player);
        });

        let uniqueCanonical = 0;
        let ambiguous = 0;
        let unresolved = 0;

        console.log('='.repeat(78));
        console.log('DIAGNOSTICO DE IDENTIDADE DAS SESSOES DO SITE');
        console.log('='.repeat(78));
        console.log(`Sessoes ativas totais: ${sessions.length}`);
        console.log(`Sessoes ativas em cadastro bloqueado/inexistente: ${blockedSessions.length}`);
        console.log(`Arquivos de mapeamento conectados: ${graph.size} identidades`);

        for (const session of blockedSessions) {
            const phone = extractDigits(session.phone_digits);
            const seeds = [session.player_id];
            if (phone) seeds.push(`${phone}@s.whatsapp.net`);
            const connected = connectedNodes(graph, seeds);
            const candidates = [...connected]
                .map((jid) => playersById.get(jid))
                .filter(Boolean)
                .sort((left, right) => scorePlayer(right) - scorePlayer(left));
            const released = candidates.filter((player) => canPlay(player) && isActive(player));
            const current = playersById.get(normalizeJid(session.player_id)) || null;

            let verdict = 'SEM PERSONAGEM LIBERADO NO GRAFO';
            if (released.length === 1) {
                verdict = 'CANONICO UNICO — MIGRACAO SEGURA';
                uniqueCanonical += 1;
            } else if (released.length > 1) {
                verdict = 'AMBIGUO — MAIS DE UM LIBERADO';
                ambiguous += 1;
            } else {
                unresolved += 1;
            }

            console.log('\n' + '-'.repeat(78));
            console.log(`[${verdict}]`);
            console.log(`Sessao atual: ${session.player_id}`);
            console.log(`Telefone salvo: ${phone || '-'}`);
            console.log(`Criada: ${session.created_at || '-'} | ultimo acesso: ${session.last_seen_at || '-'}`);
            console.log(
                `Linha atual: ${current ? playerName(current) : '(inexistente)'} | `
                + `ficha=${current?.ficha_status || '-'} | jogo=${current?.jogo_status || '-'}`
            );
            console.log(`Identidades conectadas: ${connected.size} | cadastros encontrados: ${candidates.length}`);

            if (!candidates.length) {
                console.log('  Nenhum cadastro do banco foi alcançado pelos mapeamentos.');
                continue;
            }

            for (const candidate of candidates) {
                console.log(
                    `  ${candidate.id} | ${playerName(candidate)} | score=${scorePlayer(candidate)} | `
                    + `ficha=${candidate.ficha_status || '-'} | aparencia=${candidate.personagem_aparencia_status || '-'} | `
                    + `historia=${candidate.historia_status || '-'} | jogo=${candidate.jogo_status || '-'} | `
                    + `stats=${candidate.distribution_status || '-'} | ativo=${isActive(candidate) ? 'sim' : 'nao'}`
                );
            }
        }

        console.log('\n' + '='.repeat(78));
        console.log(`Canonico unico e migracao segura: ${uniqueCanonical}`);
        console.log(`Ambiguos: ${ambiguous}`);
        console.log(`Sem personagem liberado encontrado: ${unresolved}`);
        if (uniqueCanonical === blockedSessions.length && blockedSessions.length > 0) {
            console.log('VEREDITO: TODAS AS SESSOES BLOQUEADAS PODEM SER REAPONTADAS COM SEGURANCA.');
        } else if (uniqueCanonical > 0) {
            console.log('VEREDITO: HA SESSOES REPARAVEIS, MAS EXISTEM CASOS QUE DEVEM SER PRESERVADOS.');
        } else {
            console.log('VEREDITO: O MAPEAMENTO ATUAL AINDA NAO PROVA O PERSONAGEM CANONICO.');
        }
        console.log('PREVIEW CONCLUIDO. Nenhuma alteracao foi realizada.');
        console.log('='.repeat(78));
    } finally {
        await db.close();
    }
}

main().catch((error) => {
    console.error('\nFALHA NO DIAGNOSTICO DE IDENTIDADE DO SITE:');
    console.error(error?.stack || error);
    process.exitCode = 1;
});
