'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const {
    buildCanonicalTraitDescriptionPlan,
} = require('../helpers/clover/traitCanonicalDescriptionService');

function argumentValue(name) {
    const prefix = `--${name}=`;
    const argument = process.argv.slice(2).find((entry) => entry.startsWith(prefix));
    return argument ? argument.slice(prefix.length) : null;
}

async function sha256(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('error', reject);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

async function tableColumns(db, tableName) {
    const rows = await db.all(`PRAGMA table_info(${tableName})`);
    return new Set(rows.map((row) => row.name));
}

async function readTraitTemplates(db) {
    const exists = await db.get(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'clover_trait_templates' LIMIT 1"
    );
    if (!exists?.found) {
        throw new Error('Tabela clover_trait_templates não encontrada.');
    }

    const columns = await tableColumns(db, 'clover_trait_templates');
    for (const required of ['id', 'name', 'description']) {
        if (!columns.has(required)) {
            throw new Error(`Coluna obrigatória ausente em clover_trait_templates: ${required}`);
        }
    }

    const optional = (column, fallback) => columns.has(column)
        ? column
        : `${fallback} AS ${column}`;

    return db.all(`
        SELECT id, name, description,
               ${optional('slot_key', 'NULL')},
               ${optional('effect_text', 'NULL')},
               ${optional('restrictions_text', 'NULL')},
               ${optional('status', "'active'")},
               ${optional('canonical_key', 'NULL')},
               ${optional('trait_kind', "'system'")},
               ${optional('source', 'NULL')}
        FROM clover_trait_templates
        ORDER BY slot_key ASC, name ASC, id ASC
    `);
}

async function main() {
    const databasePath = path.resolve(
        argumentValue('db') || process.env.CLOVER_DB_PATH || 'banco.sqlite'
    );
    const outputPath = path.resolve(
        argumentValue('output')
        || path.join(
            'artifacts',
            'trait-description-canonical',
            'trait-description-canonical-plan.json'
        )
    );

    if (!fs.existsSync(databasePath)) {
        throw new Error(`Banco não encontrado: ${databasePath}`);
    }

    const beforeHash = await sha256(databasePath);
    const db = await open({
        filename: databasePath,
        driver: sqlite3.Database,
        mode: sqlite3.OPEN_READONLY,
    });

    let report;
    try {
        await db.exec('PRAGMA query_only = ON');
        const integrity = await db.get('PRAGMA integrity_check');
        const templates = await readTraitTemplates(db);
        report = buildCanonicalTraitDescriptionPlan(templates);
        report.database = {
            file: path.basename(databasePath),
            integrity: integrity?.integrity_check || Object.values(integrity || {})[0] || null,
            sha256Before: beforeHash,
            openMode: 'readonly',
            queryOnly: true,
        };
    } finally {
        await db.close();
    }

    const afterHash = await sha256(databasePath);
    report.database.sha256After = afterHash;
    report.database.unchanged = beforeHash === afterHash;
    if (!report.database.unchanged) {
        throw new Error('O hash do banco mudou durante o plano somente leitura.');
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    console.log('Plano canônico de descrições concluído em modo somente leitura.');
    console.log(`Banco íntegro: ${report.database.integrity}`);
    console.log(`Banco permaneceu igual: ${report.database.unchanged}`);
    console.log(`Modelos lidos: ${report.summary.templatesRead}`);
    console.log(`Atualizações exatas planejadas: ${report.summary.plannedUpdates}`);
    console.log(`Já descritos: ${report.summary.alreadyDescribed}`);
    console.log(`Sem correspondência exata: ${report.summary.unmatched}`);
    console.log(`Ambíguos: ${report.summary.ambiguous}`);
    console.log(`Relatório: ${outputPath}`);
}

main().catch((error) => {
    console.error('Falha no plano canônico de descrições:', error);
    process.exitCode = 1;
});
