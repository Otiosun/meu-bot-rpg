'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(
    path.resolve(__dirname, '../helpers/clover/siteApiServer.js'),
    'utf8'
);

test('checklist mensal exige sessão e usa somente o personagem autenticado', () => {
    assert.match(source, /const auth = await requireSiteSession\(db, req\);/);
    assert.match(source, /url\.pathname === '\/raids\/checklist'/);
    assert.match(
        source,
        /getPlayerRaidChecklist\(db, auth\.player\.id, \{[\s\S]*?monthKey:/
    );
    assert.doesNotMatch(
        source,
        /getPlayerRaidChecklist\(db, url\.searchParams\.get\(['"]playerId['"]\)/
    );
    assert.doesNotMatch(
        source,
        /getPlayerRaidChecklist\(db, parts\[[0-9]+\]/
    );
});

test('contrato público separa checklist de prévia de criação', () => {
    assert.match(source, /'\/raids\/options', '\/raids\/usage', '\/raids\/checklist'/);
    assert.match(source, /checklist,[\s\S]*?progresso: checklist/);
    assert.match(source, /previewRaidMonthlyUsage/);
});