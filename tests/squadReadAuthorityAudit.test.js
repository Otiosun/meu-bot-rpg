'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { auditSquadReadAuthority } = require('../scripts/auditSquadReadAuthority');

test('Squad read-authority audit accepts the canonical production tree', () => {
    const audit = auditSquadReadAuthority(path.join(__dirname, '..'));
    assert.equal(audit.ok, true);
    assert.equal(audit.productionLegacyFallbackCalls, 0);
    assert.equal(audit.directLegacySquadDecisionReads, 0);
});

test('Squad read-authority audit rejects an artificial production legacy fallback', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-squad-authority-negative-'));
    try {
        const file = path.join(root, 'helpers', 'clover', 'badReader.js');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'const result = resolvePlayerSquadMembership(db, id, { allowLegacyFallback: true });\n');
        const audit = auditSquadReadAuthority(root);
        assert.equal(audit.ok, false);
        assert.ok(audit.blockers.some((item) => item.code === 'production_legacy_fallback'));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
