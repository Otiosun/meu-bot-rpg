'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { auditSourceEvidence } = require('../helpers/clover/sourceEvidenceAudit');

test('F6 source audit scans production and reports no unclassified SQL access', () => {
    const audit = auditSourceEvidence();
    assert.ok(audit.sourceFilesScanned > 0);
    assert.ok(audit.sqlAccessSites > 0);
    assert.deepEqual(audit.unclassified, []);
});

test('F6 source audit fails closed for an unclassified synthetic production write', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-f6-source-'));
    const file = path.join(dir, 'UnknownWriter.js');
    fs.writeFileSync(file, "db.run('UPDATE players SET x = 1')\n");
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    assert.equal(auditSourceEvidence([file]).unclassified.length, 1);
});
