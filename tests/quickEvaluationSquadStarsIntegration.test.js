'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const sourcePath = path.resolve(__dirname, '../helpers/clover/quickEvaluationService.js');
const source = fs.readFileSync(sourcePath, 'utf8');

function functionBody(name) {
    const start = source.indexOf(`async function ${name}(`);
    assert.notEqual(start, -1, `${name} precisa existir`);
    const next = source.indexOf('\nasync function ', start + 1);
    return source.slice(start, next === -1 ? source.length : next);
}

test('quick evaluation delegates squad Stars to the native season transaction service', () => {
    assert.match(
        source,
        /const\s*\{\s*grantSquadStarsInTransaction\s*\}\s*=\s*require\('\.\/squadSeasonStarService'\)/,
        'quickEvaluationService precisa importar o motor nativo de Stars/temporada'
    );

    const body = functionBody('applySquadStars');
    assert.match(body, /await\s+grantSquadStarsInTransaction\s*\(db,\s*\{/);
    assert.match(body, /evaluationId\s*,/);
    assert.match(body, /transactionKey:\s*`quick-evaluation:squad-stars:\$\{evaluationId\}`/);
    assert.match(body, /source:\s*'ficha_avaliacao'/);
    assert.match(body, /metadata\s*,/);
});

test('quick evaluation does not duplicate native squad-star writes with legacy SQL', () => {
    const body = functionBody('applySquadStars');

    assert.doesNotMatch(
        body,
        /UPDATE\s+clover_squads[\s\S]*?(?:current_stars|historical_stars|stars)/i,
        'applySquadStars nao deve alterar o saldo de Stars diretamente'
    );
    assert.doesNotMatch(
        body,
        /(?:INSERT\s+INTO|UPDATE)\s+clover_squad_star_ledger/i,
        'applySquadStars nao deve escrever diretamente no ledger legado'
    );
});

test('quick evaluation metadata carries the scene timestamp consumed by season resolution', () => {
    assert.match(
        source,
        /scene_sent_at:\s*sceneInfo\.sceneSentAt/,
        'metadata da avaliacao precisa preservar scene_sent_at'
    );
});
