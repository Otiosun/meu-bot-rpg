'use strict';

// Offline candidate provisioning. This module deliberately does not import
// index.js, WhatsApp, site servers, PM2 or a previous database.
const fs = require('node:fs/promises');
const path = require('node:path');
const { criarBanco } = require('../../database');
const { CURRENT_SCHEMA_MIGRATIONS } = require('./schemaMigrationCatalog');
const { inspectCloverMigrationState } = require('./schemaMigrationService');

const EMPTY_TABLES = Object.freeze([
    'jogadores','player_progress','player_onboarding','player_rolls',
    'group_settings','clover_site_sessions','clover_quick_evaluations',
    'clover_ph_ledger','clover_yulls_ledger','clover_inventory_items',
    'clover_admin_service_entries','clover_admin_service_payouts',
]);

function inside(root, candidate) {
    const relative = path.relative(root,candidate);
    return relative === '' || (!relative.startsWith('..'+path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
async function provisionSeasonLab(root) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('Informe uma pasta nova, por caminho absoluto.');
    const normalized = path.resolve(root);
    const parent = await fs.realpath(path.dirname(normalized));
    const directory = path.join(parent,path.basename(normalized));
    const repo = await fs.realpath(path.join(__dirname,'..','..'));
    if (inside(repo,directory) || inside(directory,repo)) throw new Error('A pasta de laboratório deve estar fora do repositório.');
    // mkdir without recursive is an exclusive reservation, including existing
    // symlinks and directories. Never reuse or delete a user's prior directory.
    await fs.mkdir(directory,{mode:0o700});
    const authDir = path.join(directory,'auth');
    const filename = path.join(directory,'season.sqlite');
    const manifestPath = path.join(directory,'season-lab.json');
    await fs.mkdir(authDir,{mode:0o700});
    await fs.writeFile(manifestPath,JSON.stringify({
        version:1,status:'provisioning',runtimeEnabled:false
    },null,2)+'\n',{flag:'wx',mode:0o600});
    let db;
    try {
        db = await criarBanco({filename});
        const counts = {};
        for (const table of EMPTY_TABLES) {
            const row = await db.get('SELECT COUNT(*) AS total FROM '+table);
            counts[table] = Number(row.total);
            if (counts[table] !== 0) throw new Error('Base nova contém registros em '+table+'.');
        }
        const schema = await inspectCloverMigrationState(db,{migrations:CURRENT_SCHEMA_MIGRATIONS});
        const integrity = Object.values(await db.get('PRAGMA integrity_check'))[0];
        const foreignKeys = await db.all('PRAGMA foreign_key_check');
        if (integrity!=='ok' || foreignKeys.length || !schema.schemaFingerprintMatchesLatest ||
            schema.userVersion!==CURRENT_SCHEMA_MIGRATIONS.at(-1).version)
            throw new Error('A validação da base nova não passou.');
        await db.close();
        db=null;
        const manifest={version:1,status:'ready_offline',runtimeEnabled:false,
            database:'season.sqlite',authDirectory:'auth',ownerState:'owner-access.json',
            schemaVersion:schema.userVersion,emptyTables:counts,integrity:'ok',
            createdAt:new Date().toISOString()};
        const temporaryManifest=manifestPath+'.pending';
        await fs.writeFile(temporaryManifest,JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
        await fs.rename(temporaryManifest,manifestPath);
        return manifest;
    } finally {
        if (db) await db.close().catch(()=>{});
        // On failure retain the incomplete folder for diagnosis. Never clean an
        // unknown path automatically and never mark it ready.
    }
}
module.exports={provisionSeasonLab,EMPTY_TABLES};
