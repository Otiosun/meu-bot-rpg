'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    CANONICAL_CONNECTION_OWNER,
    assertSqliteOwnership,
    auditSqliteOwnership,
} = require('../helpers/clover/sqliteOwnershipAudit');

const repositoryRoot = path.join(__dirname, '..');

test('ownership audit aprova somente o owner central e a excecao backup explicitamente classificada', () => {
    const audit = assertSqliteOwnership(repositoryRoot);
    assert.equal(audit.canonicalConnectionOwner, CANONICAL_CONNECTION_OWNER);
    assert.deepEqual(audit.blockers, []);
    assert.ok(audit.inventory.some((entry) => entry.file === CANONICAL_CONNECTION_OWNER && entry.category === 'A'));
    assert.ok(audit.inventory.some((entry) => entry.file === 'helpers/clover/sqliteBackupService.js' && entry.category === 'E'));
    assert.ok(!audit.inventory.some((entry) => entry.file === 'database/legacy.js' && entry.driverImport));
});

test('ownership audit rejeita import/open fisico sintetico fora do owner', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-sqlite-owner-negative-'));
    try {
        fs.mkdirSync(path.join(root, 'helpers', 'clover'), { recursive: true });
        fs.writeFileSync(path.join(root, 'helpers', 'clover', 'databaseConnection.js'), "const sqlite3 = require('sqlite3');\nconst { open } = require('sqlite');\nopen({ filename: 'ok.sqlite', driver: sqlite3.Database });\n");
        fs.writeFileSync(path.join(root, 'runtime.js'), "const { open } = require('sqlite');\nopen({ filename: 'bad.sqlite' });\n");
        const audit = auditSqliteOwnership(root);
        assert.equal(audit.ok, false);
        assert.deepEqual(audit.blockers.map((item) => item.file), ['runtime.js', 'runtime.js']);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
