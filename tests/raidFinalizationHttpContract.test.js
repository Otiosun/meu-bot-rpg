'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { enforceEligibleParticipant } = require('../helpers/clover/raidService');

function readSiteServerSource() {
    const currentPath = path.resolve(__dirname, '../helpers/clover/siteApiServer.js');
    const preservedPath = path.resolve(__dirname, '../helpers/clover/siteApiServerLegacy.js');
    return [currentPath, preservedPath]
        .filter((filePath) => fs.existsSync(filePath))
        .map((filePath) => fs.readFileSync(filePath, 'utf8'))
        .join('\n');
}

const siteSource = readSiteServerSource();
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

test('resumo prioriza revisão pendente antes de zero elegíveis', () => {
    const pendingSummary = enforceEligibleParticipant({
        raid: { status: 'finalization' },
        counts: { pending: 2, eligible: 0 },
        warnings: [{ code: 'raid_eligibility_pending' }],
        canComplete: false,
    });

    assert.equal(
        pendingSummary.warnings.some(
            (warning) => warning.code === 'raid_without_eligible_participants'
        ),
        false
    );

    const fullyReviewedSummary = enforceEligibleParticipant({
        raid: { status: 'finalization' },
        counts: { pending: 0, eligible: 0 },
        warnings: [],
        canComplete: true,
    });

    assert.equal(fullyReviewedSummary.canComplete, false);
    assert.equal(
        fullyReviewedSummary.warnings.some(
            (warning) => warning.code === 'raid_without_eligible_participants'
        ),
        true
    );

    const eligibleSummary = enforceEligibleParticipant({
        raid: { status: 'finalization' },
        counts: { pending: 0, eligible: 1 },
        warnings: [],
        canComplete: true,
    });

    assert.equal(eligibleSummary.canComplete, true);
    assert.deepEqual(eligibleSummary.warnings, []);

    assert.match(finalizationSource, /raid_eligibility_pending/);
    assert.match(finalizationSource, /reward_without_eligible_target/);
});

test('contrato não contém os tetos antigos de recompensa', () => {
    assert.doesNotMatch(finalizationSource, /RAID_REWARD_LIMITS/);
    assert.doesNotMatch(finalizationSource, /maximum\s*=\s*RAID_REWARD/);
    assert.match(finalizationSource, /Number\.isSafeInteger\(amount\)/);
    assert.match(finalizationSource, /unrestrictedByGameRule: true/);
});
