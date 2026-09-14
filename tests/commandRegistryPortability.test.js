'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { COMMAND_PREFIX } = require('../config/bot');
const { normalizeCommandText } = require('../helpers/textUtils');
const { resolveCommand } = require('../helpers/commandRegistry');

const directory = path.join(__dirname, '..', 'comandos');
const files = fs.readdirSync(directory).filter((file) => file.endsWith('.js'));

test('command paths are unique on case-insensitive filesystems', () => {
    const owners = new Map();
    for (const file of files) {
        const key = file.toLowerCase();
        const list = owners.get(key) || [];
        list.push(file);
        owners.set(key, list);
    }
    assert.deepEqual([...owners].filter(([, list]) => list.length > 1), [], 'Colliding command paths');
});

test('normalized names and aliases have one module owner and resolve to canonical commands', () => {
    const owners = new Map();
    const modules = new Map();
    const commands = new Map();
    for (const file of files) {
        const command = require(path.join(directory, file));
        modules.set(file, command);
        commands.set(command.nome, command);
        for (const key of new Set([command.nome, ...(command.aliases || [])].map(normalizeCommandText))) {
            if (!key) continue;
            const list = owners.get(key) || [];
            list.push(file);
            owners.set(key, list);
        }
    }
    assert.deepEqual([...owners].filter(([, list]) => list.length > 1), [], 'Duplicate normalized command ownership');
    for (const [name, file] of [
        ['lojaretorno', 'lojaretorno.js'], ['lojaretornoadmin', 'lojaRetornoAdmin.js'],
        ['ativarlojaretorno', 'lojaRetornoAdmin.js'], ['desativarlojaretorno', 'lojaRetornoAdmin.js'],
        ['statuslojaretorno', 'lojaRetornoAdmin.js'], ['loja', 'lojas.js'],
        ['comprar', 'comprar.js'], ['comprarno', 'arvores.js'],
        ['fluxofeitico', 'fluxoFeitico.js'], ['fluxoautomatico', 'filaFeitico.js'],
        ['carteira', 'saldo.js'],
    ]) {
        assert.equal(resolveCommand(`${COMMAND_PREFIX}${name}`, commands)?.command, modules.get(file), name);
    }
});
