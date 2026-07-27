'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const {
    buildResolutionPlan,
} = require('../helpers/clover/legacyEventRewardResolutionService');

function argumentValue(name) {
    const prefix = `--${name}=`;
    const argument = process.argv.slice(2).find((entry) => entry.startsWith(prefix));
    return argument ? argument.slice(prefix.length) : null;
}

function requiredArgument(name) {
    const value = argumentValue(name);
    if (!value) throw new Error(`Argumento obrigatório ausente: --${name}=...`);
    return value;
}

function parseJson(value, fallback = {}) {
    if (!value) return fallback;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
        return fallback;
    }
}

async function tableColumns(db, tableName) {
    const rows = await db.all(`PRAGMA table_info(${tableName})`);
    return new Set(rows.map((row) => row.name));
}

function selected(columns, name, fallback = 'NULL') {
    return columns.has(name) ? `i.${name}` : `${fallback} AS ${name}`;
}

async function readInventoryItems(db) {
    const inventoryColumns = await tableColumns(db, 'clover_inventory_items');
    const playerColumns = await tableColumns(db, 'jogadores');
    const characterName = playerColumns.has('personagem_nome')
        ? 'j.personagem_nome AS character_name'
        : playerColumns.has('nome')
            ? 'j.nome AS character_name'
            : 'NULL AS character_name';
    const rows = await db.all(`
        SELECT i.id,
               ${characterName},
               ${selected(inventoryColumns, 'related_id')},
               ${selected(inventoryColumns, 'source')},
               ${selected(inventoryColumns, 'template_key')},
               i.item_name,
               ${selected(inventoryColumns, 'description')},
               ${selected(inventoryColumns, 'quantity', '1')},
               ${selected(inventoryColumns, 'category')},
               ${selected(inventoryColumns, 'kind')},
               ${selected(inventoryColumns, 'origin')},
               ${selected(inventoryColumns, 'status')},
               ${selected(inventoryColumns, 'transferable', '0')},
               ${selected(inventoryColumns, 'properties_json', "'{}'")},
               ${selected(inventoryColumns, 'effects_json', "'{}'")}
        FROM clover_inventory_items i
        LEFT JOIN jogadores j ON j.id = i.player_id
        WHERE ${inventoryColumns.has('template_key')
            ? "i.template_key IS NULL OR TRIM(i.template_key) = ''"
            : '1 = 1'}
        ORDER BY i.id ASC
    `);
    return rows.map((row) => ({
        ...row,
        characterName: row.character_name,
        relatedId: row.related_id,
        templateKey: row.template_key,
        itemName: row.item_name,
        properties: parseJson(row.properties_json, {}),
        effects: parseJson(row.effects_json, {}),
    }));
}

async function readTemplates(db) {
    const rows = await db.all(`
        SELECT template_key, item_name, description, category, kind, origin,
               transferable, properties_json, effects_json
        FROM clover_item_templates
        ORDER BY template_key ASC
    `);
    return rows.map((row) => ({
        ...row,
        templateKey: row.template_key,
        itemName: row.item_name,
        properties: parseJson(row.properties_json, {}),
        effects: parseJson(row.effects_json, {}),
    }));
}

async function main() {
    const databasePath = path.resolve(requiredArgument('db'));
    const manifestPath = path.resolve(
        argumentValue('manifest')
        || path.join('data', 'inventory', 'legacy-event-reward-resolutions-v1.json')
    );
    const outputPath = path.resolve(
        argumentValue('output')
        || path.join('artifacts', 'legacy-event-rewards', 'resolution-plan.json')
    );

    if (!fs.existsSync(databasePath)) throw new Error(`Banco não encontrado: ${databasePath}`);
    if (!fs.existsSync(manifestPath)) throw new Error(`Manifesto não encontrado: ${manifestPath}`);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const db = await open({
        filename: databasePath,
        driver: sqlite3.Database,
        mode: sqlite3.OPEN_READONLY,
    });

    try {
        await db.exec('PRAGMA query_only = ON');
        await db.exec('PRAGMA busy_timeout = 10000');
        const integrity = await db.get('PRAGMA integrity_check');
        const [items, templates] = await Promise.all([
            readInventoryItems(db),
            readTemplates(db),
        ]);
        const plan = buildResolutionPlan(manifest, items, templates);
        const report = {
            ...plan,
            database: {
                file: path.basename(databasePath),
                integrity: integrity?.integrity_check || Object.values(integrity || {})[0] || null,
            },
        };
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

        console.log('Plano das recompensas legadas concluído em modo somente leitura.');
        console.log(`Integridade: ${report.database.integrity}`);
        console.log(`Decisões exatas: ${report.summary.decisions}`);
        console.log(`Unidades cobertas: ${report.summary.inventoryUnitsCovered}`);
        console.log(`Acessos de Dungeon: ${report.summary.dungeonAccessUnits}`);
        console.log(`Recompensas pendentes de definição: ${report.summary.pendingDefinitionRows}`);
        console.log(`Modelos a criar: ${report.summary.templatesToCreate}`);
        console.log(`Legados fora do manifesto: ${report.summary.unresolvedLegacyItems}`);
        console.log(`Relatório: ${outputPath}`);
    } finally {
        await db.close();
    }
}

main().catch((error) => {
    console.error(error?.stack || error);
    if (error?.code) console.error(`Código: ${error.code}`);
    if (error?.details) console.error(JSON.stringify(error.details, null, 2));
    process.exitCode = 1;
});
