'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const { extractPhoneNumber, normalizeJid } = require('../helpers/groupAccess');

const input = String(process.argv[2] || '').replace(/\D/g, '');
const databaseFile = path.resolve(process.argv[3] || 'banco.sqlite');
const authInfoDir = path.resolve(process.env.CLOVER_AUTH_INFO_DIR || 'auth_info');

if (!input || input.length < 4) {
    console.error('Uso: node scripts/diagnosePlayerIdentityByPhone.js <telefone-ou-sufixo> [banco.sqlite]');
    process.exit(1);
}

function openReadOnly(filename) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(filename, sqlite3.OPEN_READONLY, (error) => {
            if (error) reject(error);
            else resolve(db);
        });
    });
}

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (error, rows) => {
            if (error) reject(error);
            else resolve(rows || []);
        });
    });
}

function close(db) {
    return new Promise((resolve) => db.close(() => resolve()));
}

function digits(value) {
    return String(value ?? '').replace(/\D/g, '');
}

function matchesInput(value) {
    const clean = digits(value);
    return Boolean(clean) && (
        clean === input
        || clean.endsWith(input)
        || input.endsWith(clean)
    );
}

function safeJson(value) {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function displayName(row = {}) {
    return [row.personagem_nome, row.display_name, row.nome, row.nome_real]
        .map((value) => String(value || '').trim())
        .find((value) => value && value !== '-') || 'Sem nome';
}

async function tableExists(db, table) {
    const rows = await all(db, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [table]);
    return rows.length > 0;
}

async function tableColumns(db, table) {
    return all(db, `PRAGMA table_info("${String(table).replace(/"/g, '""')}")`);
}

async function inspectPlayers(db) {
    if (!await tableExists(db, 'jogadores')) return [];
    const rows = await all(db, 'SELECT * FROM jogadores ORDER BY id');
    return rows
        .filter((row) => matchesInput(row.id) || matchesInput(row.telefone) || matchesInput(row.phone))
        .map((row) => ({
            id: row.id,
            normalizedId: normalizeJid(row.id),
            extractedPhone: extractPhoneNumber(row.id),
            name: displayName(row),
            personagem_nome: row.personagem_nome || null,
            ficha_status: row.ficha_status || null,
            jogo_status: row.jogo_status || null,
            historia_status: row.historia_status || null,
            esquadrao: row.esquadrao || null,
            raca: row.raca || null,
            classe: row.classe || null,
            grimorio: row.grimorio || null,
            magia: row.magia || null,
        }));
}

async function inspectIdentityReferences(db) {
    const tables = await all(db, `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`);
    const findings = [];
    const columnPattern = /(player|jogador|jid|phone|telefone|canonical|alias|subject|recruit|seller|buyer|owner|created_by|assigned_by)/i;

    for (const { name: table } of tables) {
        const columns = await tableColumns(db, table);
        const searchable = columns.filter((column) => columnPattern.test(column.name));
        if (!searchable.length) continue;

        for (const column of searchable) {
            const escapedTable = String(table).replace(/"/g, '""');
            const escapedColumn = String(column.name).replace(/"/g, '""');
            let rows = [];
            try {
                rows = await all(
                    db,
                    `SELECT rowid AS _rowid, * FROM "${escapedTable}" WHERE CAST("${escapedColumn}" AS TEXT) LIKE ? LIMIT 25`,
                    [`%${input}%`]
                );
            } catch {
                continue;
            }
            for (const row of rows) {
                if (!matchesInput(row[column.name])) continue;
                findings.push({
                    table,
                    column: column.name,
                    rowid: row._rowid ?? null,
                    value: row[column.name],
                    status: row.status ?? row.ficha_status ?? row.jogo_status ?? null,
                    related: {
                        player_id: row.player_id ?? null,
                        canonical_player_id: row.canonical_player_id ?? null,
                        phone_digits: row.phone_digits ?? null,
                        expires_at: row.expires_at ?? null,
                        used_at: row.used_at ?? null,
                        revoked_at: row.revoked_at ?? null,
                    },
                });
            }
        }
    }
    return findings;
}

function inspectAuthMappings() {
    if (!fs.existsSync(authInfoDir)) return [];
    const findings = [];
    for (const file of fs.readdirSync(authInfoDir)) {
        if (!file.startsWith('lid-mapping-') || !file.endsWith('.json')) continue;
        const filePath = path.join(authInfoDir, file);
        let raw = '';
        try {
            raw = fs.readFileSync(filePath, 'utf8');
        } catch {
            continue;
        }
        const parsed = safeJson(raw);
        const values = [file, raw];
        if (!values.some(matchesInput)) continue;
        findings.push({
            file,
            path: filePath,
            parsed,
        });
    }
    return findings;
}

(async () => {
    if (!fs.existsSync(databaseFile)) throw new Error(`Banco não encontrado: ${databaseFile}`);
    const db = await openReadOnly(databaseFile);
    try {
        const players = await inspectPlayers(db);
        const references = await inspectIdentityReferences(db);
        const mappings = inspectAuthMappings();

        console.log('\n=== DIAGNÓSTICO DE IDENTIDADE POR TELEFONE ===');
        console.log('Modo: SOMENTE LEITURA');
        console.log(`Busca: ${input}`);
        console.log(`Banco: ${databaseFile}`);
        console.log(`Auth info: ${authInfoDir}`);

        console.log('\n=== CADASTROS EM JOGADORES ===');
        if (!players.length) console.log('Nenhum cadastro encontrado pelo número/sufixo.');
        else console.table(players);

        console.log('\n=== MAPEAMENTOS LID ↔ TELEFONE ===');
        if (!mappings.length) console.log('Nenhum mapeamento encontrado pelo número/sufixo.');
        else console.dir(mappings, { depth: 6, colors: true });

        console.log('\n=== REFERÊNCIAS NO BANCO ===');
        if (!references.length) console.log('Nenhuma referência adicional encontrada.');
        else console.table(references.map((item) => ({
            tabela: item.table,
            coluna: item.column,
            rowid: item.rowid,
            valor: item.value,
            status: item.status,
            player_id: item.related.player_id,
            canonical: item.related.canonical_player_id,
            phone: item.related.phone_digits,
            expiracao: item.related.expires_at,
            usado: item.related.used_at,
            revogado: item.related.revoked_at,
        })));

        const distinctPlayerIds = new Set([
            ...players.map((item) => item.id),
            ...references.flatMap((item) => [item.value, item.related.player_id, item.related.canonical_player_id])
                .filter((value) => String(value || '').includes('@')),
        ]);

        console.log('\n=== RESUMO ===');
        console.log(`Cadastros encontrados: ${players.length}`);
        console.log(`IDs distintos envolvidos: ${distinctPlayerIds.size}`);
        console.log(`Mapeamentos encontrados: ${mappings.length}`);
        console.log(`Referências adicionais: ${references.length}`);
        console.log('\nNenhum dado foi alterado.');
    } finally {
        await close(db);
    }
})().catch((error) => {
    console.error('\nFALHA NO DIAGNÓSTICO:');
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
