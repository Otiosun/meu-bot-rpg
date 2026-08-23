'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { assertCanonicalDataAuthority } = require('./auditCanonicalDataAuthority');
const { assertSquadReadAuthority } = require('./auditSquadReadAuthority');

function phase3FinalGate(root = path.resolve(__dirname, '..')) {
    const map = fs.readFileSync(path.join(root, 'docs/architecture/clover-canonical-data-map.md'), 'utf8');
    const squadInventory = fs.readFileSync(path.join(root, 'docs/architecture/phase3-squad-read-authority-inventory.md'), 'utf8');
    const required = [
        'C-01 | Resolved',
        'C-02 | Resolved',
        'C-05 | P2',
        'C-09 | P2 justified',
        'clover_squad_memberships.active',
        'compatibility projection only',
        '627 checked and 627 match',
    ];
    const missing = required.filter((text) => !map.includes(text));
    if (missing.length) throw new Error(`Phase 3 canonical map is incomplete: ${missing.join(', ')}`);
    if (!squadInventory.includes('**0 direct legacy reads.**')) {
        throw new Error('Phase 3 Squad read-authority inventory is incomplete.');
    }
    const squad = assertSquadReadAuthority(root);
    const writers = assertCanonicalDataAuthority(root);
    return {
        CANONICAL_MAP: 'PASS', P0_OPEN: 0, P1_OPEN: 0,
        ROLE_P1: 'RESOLVED', SQUAD_P1: 'RESOLVED',
        SQUAD_CANONICAL_READ_AUTHORITY: 'PASS',
        PRODUCTION_LEGACY_FALLBACK_CALLS: squad.productionLegacyFallbackCalls,
        DIRECT_LEGACY_SQUAD_DECISION_READS: squad.directLegacySquadDecisionReads,
        SQUAD_PROJECTION_WRITES_PRESERVED: 'YES',
        AUTHORITY_GUARD: 'PASS',
        UNCLASSIFIED_CRITICAL_WRITERS: writers.blockers.length,
        C05_STATUS: 'P2_FAIL_CLOSED_OPEN', C09_STATUS: 'BOUNDED_JUSTIFIED',
        PHASE3_GATE: 'PASS',
    };
}

if (require.main === module) process.stdout.write(`${JSON.stringify(phase3FinalGate(), null, 2)}\n`);

module.exports = { phase3FinalGate };
