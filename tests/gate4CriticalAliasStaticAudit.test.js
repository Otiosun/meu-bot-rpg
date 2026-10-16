'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const COMMANDS_DIR = path.join(ROOT, 'comandos');

const CRITICAL = new Map([
    ['avaliacao', 'avaliacoes.js'],
    ['avaliação', 'avaliacoes.js'],
    ['avaliacoes', 'avaliacoes.js'],
    ['avaliações', 'avaliacoes.js'],
    ['aprovar', 'avaliacoes.js'],
    ['negar', 'avaliacoes.js'],
    ['proxima', 'avaliacoes.js'],
    ['próxima', 'avaliacoes.js'],
    ['enviarfeitico', 'enviarAvaliacao.js'],
    ['enviarfeitiço', 'enviarAvaliacao.js'],
    ['enviarprototipo', 'enviarAvaliacao.js'],
    ['enviarprotótipo', 'enviarAvaliacao.js'],
]);

function exportedCommandPatterns(source) {
    const exportIndex = source.indexOf('module.exports');
    if (exportIndex < 0) return [];
    const block = source.slice(exportIndex);
    const patterns = [];

    const nameMatch = block.match(/\bnome\s*:\s*`\$\{COMMAND_PREFIX\}([^`]+)`/);
    if (nameMatch) patterns.push(nameMatch[1]);

    const aliasesMatch = block.match(/\baliases\s*:\s*\[([\s\S]*?)\]/);
    if (aliasesMatch) {
        const regex = /`\$\{COMMAND_PREFIX\}([^`]+)`/g;
        let match;
        while ((match = regex.exec(aliasesMatch[1]))) patterns.push(match[1]);
    }
    return patterns;
}

function ownersForCriticalAliases() {
    const owners = new Map([...CRITICAL.keys()].map((alias) => [alias, []]));
    for (const file of fs.readdirSync(COMMANDS_DIR).filter((name) => name.endsWith('.js'))) {
        const source = fs.readFileSync(path.join(COMMANDS_DIR, file), 'utf8');
        for (const pattern of exportedCommandPatterns(source)) {
            if (owners.has(pattern)) owners.get(pattern).push(file);
        }
    }
    return owners;
}

test('aliases críticos da fila universal têm owner único sem importar comandos legados', () => {
    const owners = ownersForCriticalAliases();
    for (const [alias, expectedOwner] of CRITICAL) {
        assert.deepEqual(
            owners.get(alias),
            [expectedOwner],
            `alias ${alias} precisa pertencer somente a ${expectedOwner}`
        );
    }
});

module.exports = { exportedCommandPatterns, ownersForCriticalAliases };
