'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const service = require('../helpers/clover/blankPlayerIdentityCleanupService');
const runner = require('../scripts/cleanupBlankPlayerIdentities');

function placeholder(rowid, overrides = {}) {
    return {
        __rowid__: rowid,
        id: null,
        nome: 'Cacador',
        display_name: 'Cacador',
        personagem_nome: '-',
        canonical_player_id: null,
        ficha_status: 'incompleta',
        jogo_status: 'bloqueado',
        esquadrao: '-',
        is_shadow: 0,
        merged_into: null,
        archived_at: null,
        archive_reason: null,
        ...overrides,
    };
}

function auditReport(rows = [placeholder(48), placeholder(54)]) {
    return {
        write: false,
        queryOnlySafe: true,
        database: { unchanged: true, sha256: 'hash-ok' },
        result: {
            summary: {
                blankIdentityCount: rows.length,
                exactPlaceholderCount: rows.length,
                dataBearingCount: 0,
                signatureMismatchCount: 0,
                foreignKeyDefinitionCount: 0,
                explicitRowidReferenceCount: 0,
                externalNameReferenceCount: 0,
                critical: false,
                reviewRequired: true,
            },
            reviewReasons: ['players_id_allows_null'],
            rows: rows.map((row) => ({
                rowid: row.__rowid__,
                placeholderSignature: true,
                substantiveDeviationCount: 0,
            })),
        },
    };
}

class FakeDb {
    constructor(rows, options = {}) {
        this.rows = rows.map((row) => ({ ...row }));
        this.execs = [];
        this.runs = [];
        this.archives = [];
        this.deleteMismatchAt = options.deleteMismatchAt || null;
        this.nextArchiveId = 1;
    }

    async all(sql, params = []) {
        if (/FROM jogadores/i.test(sql) && /rowid IN/i.test(sql)) {
            return this.rows
                .filter((row) => params.includes(row.__rowid__))
                .sort((a, b) => a.__rowid__ - b.__rowid__);
        }
        throw new Error(`unexpected all: ${sql}`);
    }

    async get(sql) {
        if (/COUNT\(\*\).*FROM jogadores/is.test(sql)) {
            return {
                total: this.rows.filter((row) => (
                    row.id === null || String(row.id || '').trim() === ''
                )).length,
            };
        }
        throw new Error(`unexpected get: ${sql}`);
    }

    async exec(sql) {
        this.execs.push(sql);
    }

    async run(sql, params = []) {
        this.runs.push({ sql, params });
        if (/INSERT INTO clover_blank_player_identity_archive/i.test(sql)) {
            this.archives.push({
                id: this.nextArchiveId,
                sourceDatabaseSha256: params[0],
                sourceRowid: params[1],
                rowJson: params[2],
                actor: params[3],
                reason: params[4],
            });
            return { lastID: this.nextArchiveId++ };
        }
        if (/DELETE FROM jogadores/i.test(sql)) {
            const rowid = Number(params[0]);
            if (this.deleteMismatchAt === rowid) return { changes: 0 };
            const before = this.rows.length;
            this.rows = this.rows.filter((row) => row.__rowid__ !== rowid);
            return { changes: before - this.rows.length };
        }
        throw new Error(`unexpected run: ${sql}`);
    }
}

test('parseArgs preserva dry-run padrão e aceita proteções de apply', () => {
    const parsed = runner.parseArgs([
        '--db=copy.sqlite',
        '--audit-report', 'audit.json',
        '--output=receipt.json',
        '--expected-runner-sha=abc123',
        '--expected-db-sha256=hash-ok',
        '--actor=tester',
        '--reason=limpeza controlada',
        '--apply',
    ]);
    assert.equal(parsed.db, 'copy.sqlite');
    assert.equal(parsed.auditReport, 'audit.json');
    assert.equal(parsed.apply, true);
    assert.equal(parsed.actor, 'tester');
    assert.equal(parsed.reason, 'limpeza controlada');
    assert.equal(runner.parseArgs([]).apply, false);
    assert.equal(runner.sameSha('abcdef1234', 'abcdef'), true);
    assert.equal(runner.sameSha('abcdef', 'abc999'), false);
});

test('evidência aceita somente placeholders exatos e revisão de id anulável', () => {
    const evidence = service.validateAuditEvidence(auditReport(), 'hash-ok');
    assert.equal(evidence.expectedCount, 2);
    assert.deepEqual(evidence.expectedRowids, [48, 54]);
    assert.deepEqual(evidence.allowedReviewReasons, ['players_id_allows_null']);
});

test('evidência com dados ou referência externa é bloqueada', () => {
    const report = auditReport();
    report.result.summary.dataBearingCount = 1;
    report.result.summary.externalNameReferenceCount = 2;
    assert.throws(
        () => service.validateAuditEvidence(report, 'hash-ok'),
        (error) => error?.code === 'unsafe_blank_identity_evidence'
            && error.details.errors.includes('data_bearing_blank_identity_found')
            && error.details.errors.includes('external_name_reference_found')
    );
});

test('plano exige os mesmos rowids, assinatura e população auditada', async () => {
    const rows = [placeholder(48), placeholder(54)];
    const db = new FakeDb(rows);
    const evidence = service.validateAuditEvidence(auditReport(rows), 'hash-ok');
    const plan = await service.buildCleanupPlan(db, evidence);
    assert.equal(plan.safe, true);
    assert.equal(plan.rowCount, 2);
    assert.deepEqual(plan.rowids, [48, 54]);

    const changed = new FakeDb([placeholder(48, { nome: 'Jogador real' }), placeholder(54)]);
    await assert.rejects(
        () => service.buildCleanupPlan(changed, evidence),
        (error) => error?.code === 'blank_identity_signature_changed'
    );
});

test('contenção cria arquivo e bloqueios de INSERT e UPDATE nulos', async () => {
    const db = new FakeDb([]);
    await service.ensureContainmentSchema(db);
    const sql = db.execs.join('\n');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS clover_blank_player_identity_archive/);
    assert.match(sql, /CREATE TRIGGER IF NOT EXISTS trg_jogadores_require_nonblank_id_insert/);
    assert.match(sql, /CREATE TRIGGER IF NOT EXISTS trg_jogadores_require_nonblank_id_update/);
    assert.match(sql, /RAISE\(ABORT, 'player_id_required'\)/);
});

test('apply arquiva todos os campos, remove os placeholders e instala contenção', async () => {
    const rows = [placeholder(48), placeholder(54)];
    const db = new FakeDb(rows);
    const evidence = service.validateAuditEvidence(auditReport(rows), 'hash-ok');
    const plan = await service.buildCleanupPlan(db, evidence);
    const result = await service.applyCleanupPlan(db, plan, {
        actor: 'owner@lid',
        reason: 'Remoção reversível dos placeholders nulos auditados',
    });
    assert.equal(result.write, true);
    assert.equal(result.archivedCount, 2);
    assert.equal(result.deletedCount, 2);
    assert.equal(result.containmentInstalled, true);
    assert.equal(db.rows.length, 0);
    assert.equal(db.archives.length, 2);
    assert.equal(JSON.parse(db.archives[0].rowJson).nome, 'Cacador');
    assert.equal(db.execs[0], 'BEGIN IMMEDIATE');
    assert.equal(db.execs.at(-1), 'COMMIT');
});

test('falha de deleção executa rollback e não declara sucesso', async () => {
    const rows = [placeholder(48), placeholder(54)];
    const db = new FakeDb(rows, { deleteMismatchAt: 54 });
    const evidence = service.validateAuditEvidence(auditReport(rows), 'hash-ok');
    const plan = await service.buildCleanupPlan(db, evidence);
    await assert.rejects(
        () => service.applyCleanupPlan(db, plan, {
            actor: 'owner@lid',
            reason: 'Remoção reversível dos placeholders nulos auditados',
        }),
        (error) => error?.code === 'placeholder_delete_count_mismatch'
    );
    assert.equal(db.execs.at(-1), 'ROLLBACK');
});
