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
async function verifySeasonLab(root) {
    if(typeof root!=='string'||!path.isAbsolute(root)) throw new Error('Informe a pasta de laboratório por caminho absoluto.');
    const requested=path.resolve(root);
    const dir=await fs.realpath(requested);
    const expected=path.join(await fs.realpath(path.dirname(requested)),path.basename(requested));
    if(dir!==expected||!(await fs.lstat(requested)).isDirectory()) throw new Error('Pasta de laboratório não pode ser um link.');
    const repo=await fs.realpath(path.join(__dirname,'..','..'));
    if(inside(repo,dir)||inside(dir,repo)) throw new Error('A pasta de laboratório deve estar fora do repositório.');
    async function checkedFile(name){
        const p=path.join(dir,name),stat=await fs.lstat(p);
        if(!stat.isFile()||stat.nlink!==1) throw new Error('Arquivo de laboratório não é exclusivo: '+name);
        return p;
    }
    const manifest=JSON.parse(await fs.readFile(await checkedFile('season-lab.json'),'utf8'));
    if(manifest.version!==1||manifest.status!=='ready_offline'||manifest.runtimeEnabled!==false
        ||manifest.database!=='season.sqlite'||manifest.authDirectory!=='auth'||manifest.ownerState!=='owner-access.json')
        throw new Error('Manifesto de laboratório inválido.');
    const auth=path.join(dir,'auth');
    if(!(await fs.lstat(auth)).isDirectory()||(await fs.readdir(auth)).length)
        throw new Error('Diretório de autenticação não está vazio ou é um link.');
    try {
        await fs.lstat(path.join(dir,'owner-access.json'));
        throw new Error('Laboratório já possui estado de proprietário.');
    } catch(error){if(error.code!=='ENOENT')throw error;}
    const filename=await checkedFile('season.sqlite');
    for(const suffix of ['-wal','-shm','-journal']){
        try{
            const stat=await fs.lstat(filename+suffix);
            // SQLite read-only WAL connections can leave a shared-memory index.
            // It holds no committed database pages; never delete it ourselves.
            // Refuse nonempty WAL/journal and every linked/nonregular sidecar.
            if(!stat.isFile()||stat.nlink!==1||(suffix!=='-shm'&&stat.size!==0))
                throw new Error('Banco possui arquivo auxiliar ativo: '+suffix);
        }catch(error){if(error.code!=='ENOENT')throw error;}
    }
    // No startup or schema updates. Open only the explicitly checked database.
    const {open}=require('sqlite');
    const sqlite3=require('sqlite3');
    const db=await open({filename,driver:sqlite3.Database,mode:sqlite3.OPEN_READONLY});
    try {
        const schema=await inspectCloverMigrationState(db,{migrations:CURRENT_SCHEMA_MIGRATIONS});
        if(!schema.schemaFingerprintMatchesLatest||schema.userVersion!==CURRENT_SCHEMA_MIGRATIONS.at(-1).version
            ||schema.userVersion!==manifest.schemaVersion||Object.values(await db.get('PRAGMA integrity_check'))[0]!=='ok'
            ||(await db.all('PRAGMA foreign_key_check')).length)
            throw new Error('Integridade ou versão do esquema divergente.');
        const counts={};
        for(const table of EMPTY_TABLES){
            counts[table]=Number((await db.get('SELECT COUNT(*) AS total FROM '+table)).total);
            if(counts[table]!==0)throw new Error('Base de laboratório não está limpa: '+table);
        }
        return {ok:true,status:'ready_offline',runtimeEnabled:false,schemaVersion:schema.userVersion,emptyTables:counts};
    }finally{await db.close();}
}
module.exports={provisionSeasonLab,verifySeasonLab,EMPTY_TABLES};
