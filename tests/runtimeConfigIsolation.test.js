'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const loaderPath = path.resolve(__dirname, '../helpers/clover/configLoader.js');

test('runtime Clover config is isolated from PM2 cwd and excludes legacy Comum', () => {
    const originalCwd = process.cwd();
    const foreignCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-foreign-cwd-'));

    fs.mkdirSync(path.join(foreignCwd, 'data', 'clover'), { recursive: true });
    fs.writeFileSync(
        path.join(foreignCwd, 'data', 'clover', 'raridadesMagicas.json'),
        JSON.stringify([
            { key: 'comum', name: 'Comum', category: 'magic_rarity', level: 1, chance: 100 },
        ]),
        'utf8'
    );

    try {
        process.chdir(foreignCwd);
        delete require.cache[require.resolve(loaderPath)];
        const { loadCloverConfigs } = require(loaderPath);
        const config = loadCloverConfigs({ forceReload: true });
        const rarities = config.lists.magicRarities.map(({ key, chance }) => ({ key, chance }));

        assert.deepEqual(rarities, [
            { key: 'incomum', chance: 42 },
            { key: 'rara', chance: 30 },
            { key: 'epica', chance: 17 },
            { key: 'lendaria', chance: 10 },
            { key: 'mitica', chance: 1 },
        ]);
        assert.equal(config.maps.magicRarities.has('comum'), false);
    } finally {
        process.chdir(originalCwd);
        delete require.cache[require.resolve(loaderPath)];
        fs.rmSync(foreignCwd, { recursive: true, force: true });
    }
});
