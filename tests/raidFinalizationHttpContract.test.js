'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const siteSource = fs.readFileSync(
    path.resolve(__dirname, '../helpers/clover/siteApiServer.js'),
    'utf8'
);
const publicRaidSource = fs.readFileSync(
    path.resolve(__dirname, '../helpers/clover/raidService.js'),
    'utf8'
);
const finalizationSource = fs.readFileSync(
    path.resolve(__dirname, '../helpers/clover/raidFinalizationService.js'),
    'utf8'
);

test('resumo de finalização exige sessão e usa o ator autenticado', () => {
    assert.match(siteSource, /const finalizationMatch = url\.pathname\.match/);
    assert.match(siteSource, /const auth = await requireSiteSession\(db, req\);/);
    assert.match(
        siteSource,
        /getRaidFinalizationSummary\(db, raidKey, auth\.player\.id\)/
    );
    assert.doesNotMatch(
        siteSource,
        /getRaidFinalizationSummary\(db, raidKey, url\.searchParams/
    );
});

test('revisão de presença usa alvo da rota e host da sessão', () => {
    assert.match(
        siteSource,
        /\/finalization\\\/participants\\\/\(\[\^\/\]\+\)/
    );
    assert.match(siteSource, /const body = await readJsonBody\(req\);/);
    assert.match(
        siteSource,
        /setRaidParticipantFinalization\([\s\S]*?auth\.player\.id,[\s\S]*?targetPlayerId,[\s\S]*?body/
    );
    assert.match(finalizationSource, /await requireHost\(db, raid, actorId\)/);
    assert.match(finalizationSource, /finalization_note_required/);
});

test('conclusão pública bloqueia zero elegíveis e revisão pendente', () => {
    assert.match(publicRaidSource, /raid_without_eligible_participants/);
    assert.match(publicRaidSource, /Number\(summary\.counts\?\.eligible \|\| 0\) === 0/);
    assert.match(finalizationSource, /raid_eligibility_pending/);
    assert.match(finalizationSource, /reward_without_eligible_target/);
});

test('contrato não contém os tetos antigos de recompensa', () => {
    assert.doesNotMatch(finalizationSource, /RAID_REWARD_LIMITS/);
    assert.doesNotMatch(finalizationSource, /maximum\s*=\s*RAID_REWARD/);
    assert.match(finalizationSource, /Number\.isSafeInteger\(amount\)/);
    assert.match(finalizationSource, /unrestrictedByGameRule: true/);
});
