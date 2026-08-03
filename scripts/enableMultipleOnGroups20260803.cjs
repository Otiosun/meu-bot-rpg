'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'helpers', 'clover', 'groupManager.js');
const BACKUP_DIR = path.join(ROOT, 'backups');
const CONFIRMATION = 'ATIVAR-MULTIPLOS-GRUPOS-ON-2026-08-03';
const MULTI_MARKER = 'function parseConfiguredCloverGroups(value) {';
const CONFIGURED_MARKER = 'const configuredGroups = await getCloverGroups(db, type);';

function parseArgs(argv) {
    const apply = argv.includes('--apply');
    const confirmation = argv.find((arg) => arg.startsWith('--confirm='))?.slice('--confirm='.length) || '';
    if (apply && confirmation !== CONFIRMATION) {
        throw new Error(`Aplicacao bloqueada. Use --apply --confirm=${CONFIRMATION}`);
    }
    return { apply };
}

function stamp() {
    return new Date().toISOString().replace(/[-:T]/g, '').replace(/\.\d{3}Z$/, '');
}

function normalizeLf(value) {
    return String(value || '').replace(/\r\n/g, '\n');
}

function restoreEol(value, useCrLf) {
    return useCrLf ? value.replace(/\n/g, '\r\n') : value;
}

function replaceBetween(text, startNeedle, endNeedle, replacement) {
    const start = text.indexOf(startNeedle);
    if (start < 0) throw new Error(`Nao encontrei: ${startNeedle}`);
    const end = text.indexOf(endNeedle, start);
    if (end < 0) throw new Error(`Nao encontrei o fim: ${endNeedle}`);
    return text.slice(0, start) + replacement + text.slice(end);
}

function buildGroupFunctions() {
    return `function parseConfiguredCloverGroups(value) {
    const raw = String(value || '').trim();
    if (!raw) return [];

    let values = null;
    try {
        const parsed = JSON.parse(raw);
        values = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
        values = raw.split(/[\\n,;]+/);
    }

    const groups = [];
    for (const valueItem of values || []) {
        const normalized = normalizeJid(valueItem);
        if (!normalized) continue;
        if (!groups.some((existing) => isSameUser(existing, normalized))) {
            groups.push(normalized);
        }
    }
    return groups;
}

async function getCloverGroups(db, type) {
    const key = GROUP_SETTING_KEYS[type];
    if (!key) return [];
    return parseConfiguredCloverGroups(await getCloverSetting(db, key));
}

async function setCloverGroup(db, type, groupId) {
    const key = GROUP_SETTING_KEYS[type];
    if (!key) throw new Error(\`Tipo de grupo Clover invalido: \${type}\`);

    const normalizedGroupId = normalizeJid(groupId);
    if (!normalizedGroupId) throw new Error('ID de grupo Clover invalido.');

    if (type !== 'on') {
        await setCloverSetting(db, key, normalizedGroupId);
        return [normalizedGroupId];
    }

    const currentGroups = await getCloverGroups(db, type);
    const nextGroups = [
        ...currentGroups.filter((existing) => !isSameUser(existing, normalizedGroupId)),
        normalizedGroupId,
    ];
    await setCloverSetting(db, key, JSON.stringify(nextGroups));
    return nextGroups;
}

async function getCloverGroup(db, type) {
    const groups = await getCloverGroups(db, type);
    return groups.length ? groups[groups.length - 1] : null;
}

`;
}

function patchSource(original) {
    const useCrLf = original.includes('\r\n');
    let text = normalizeLf(original);
    let changed = false;

    if (!text.includes(MULTI_MARKER)) {
        text = replaceBetween(
            text,
            'async function setCloverGroup(db, type, groupId) {',
            'async function setGroupInviteLink(db, type, link) {',
            buildGroupFunctions()
        );
        changed = true;
    }

    if (!text.includes(CONFIGURED_MARKER)) {
        const oldBlock = `async function isConfiguredCloverGroup(db, type, groupId) {
    const configured = await getCloverGroup(db, type);
    return Boolean(configured) && isSameUser(groupId, configured);
}`;
        const newBlock = `async function isConfiguredCloverGroup(db, type, groupId) {
    const configuredGroups = await getCloverGroups(db, type);
    return configuredGroups.some((configured) => isSameUser(groupId, configured));
}`;
        if (!text.includes(oldBlock)) throw new Error('Nao encontrei isConfiguredCloverGroup no formato esperado.');
        text = text.replace(oldBlock, newBlock);
        changed = true;
    }

    if (!text.includes('    getCloverGroups,\n')) {
        const exportNeedle = '    getCloverGroup,\n';
        if (!text.includes(exportNeedle)) throw new Error('Nao encontrei export getCloverGroup.');
        text = text.replace(exportNeedle, `${exportNeedle}    getCloverGroups,\n`);
        changed = true;
    }

    return { text: restoreEol(text, useCrLf), changed };
}

function syntaxCheck(filePath) {
    const result = spawnSync(process.execPath, ['--check', filePath], {
        cwd: ROOT,
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
    });
    if (result.error || result.status !== 0) {
        throw new Error(result.error?.message || result.stderr || result.stdout || 'Erro de sintaxe desconhecido.');
    }
}

function main() {
    const { apply } = parseArgs(process.argv.slice(2));
    if (!fs.existsSync(TARGET)) throw new Error(`Arquivo ausente: ${TARGET}`);

    const original = fs.readFileSync(TARGET, 'utf8');
    const patched = patchSource(original);

    console.log('='.repeat(72));
    console.log('MULTIPLOS GRUPOS ON — CLOVER MULTICOLOR');
    console.log('='.repeat(72));
    console.log(`Estado: ${patched.changed ? 'pronto para instalar' : 'ja instalado'}`);
    console.log('ON: cada .#setgrupoon adicionara o grupo sem remover os anteriores.');
    console.log('OFF, Arquivos, Comunidade e Feiticos: continuam com um grupo cada.');

    if (!apply) {
        console.log('PREVIEW CONCLUIDO. Nenhuma alteracao foi realizada.');
        console.log('='.repeat(72));
        return;
    }

    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const backup = path.join(BACKUP_DIR, `groupManager.before-multiple-on-${stamp()}.js`);
    fs.copyFileSync(TARGET, backup);

    try {
        if (patched.changed) fs.writeFileSync(TARGET, patched.text, 'utf8');
        syntaxCheck(TARGET);
    } catch (error) {
        fs.copyFileSync(backup, TARGET);
        throw error;
    }

    console.log(`Backup: ${backup}`);
    console.log('APLICACAO CONCLUIDA. Reinicie clover-rpg.');
    console.log('Depois, use .#setgrupoon dentro de cada grupo ON desejado.');
    console.log('='.repeat(72));
}

try {
    main();
} catch (error) {
    console.error('\nFALHA NA ATIVACAO DE MULTIPLOS GRUPOS ON:');
    console.error(error?.stack || error);
    process.exitCode = 1;
}
