'use strict';

const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const {
    applyQuickEvaluationStarBackfill,
    planQuickEvaluationStarBackfill,
} = require('../helpers/clover/quickEvaluationStarBackfillService');

const APPLY_CONFIRMATION = 'BACKFILL_SEASON_STARS';

function argValue(name) {
    const prefix = `--${name}=`;
    const item = process.argv.find((arg) => arg.startsWith(prefix));
    return item ? item.slice(prefix.length) : null;
}

function hasFlag(name) {
    return process.argv.includes(`--${name}`);
}

function parseExpectedInteger(name) {
    const raw = argValue(name);
    if (raw === null) return null;
    const number = Number(raw);
    if (!Number.isInteger(number) || number < 0) {
        throw new Error(`--${name} precisa ser inteiro >= 0.`);
    }
    return number;
}

async function verifyDatabase(db) {
    const quickCheckRow = await db.get('PRAGMA quick_check');
    const quickCheck = quickCheckRow ? Object.values(quickCheckRow)[0] : null;
    const foreignKeyViolations = (await db.all('PRAGMA foreign_key_check')).length;
    return { quickCheck, foreignKeyViolations };
}

function sanitizedPlan(plan) {
    return {
        schemaReady: plan.schemaReady,
        missingTables: plan.missingTables || [],
        scanned: plan.scanned || 0,
        candidateCount: plan.candidateCount || 0,
        alreadyNative: plan.alreadyNative || 0,
        invalidCount: plan.invalidCount || 0,
        invalid: plan.invalid || [],
        candidates: (plan.candidates || []).map((item) => ({
            evaluationId: item.evaluationId,
            squadKey: item.squadKey,
            amount: item.amount,
            seasonId: item.seasonId,
            sceneSentAt: item.sceneSentAt,
        })),
    };
}

async function main() {
    const apply = hasFlag('apply');
    const confirmation = argValue('confirm');
    const expectedCandidates = parseExpectedInteger('expected-candidates');
    const dbArg = argValue('db');
    const filename = path.resolve(dbArg || path.join(__dirname, '..', 'banco.sqlite'));
    const db = await open({ filename, driver: sqlite3.Database });

    try {
        await db.exec('PRAGMA busy_timeout = 10000');
        const integrityBefore = await verifyDatabase(db);
        if (integrityBefore.quickCheck !== 'ok' || integrityBefore.foreignKeyViolations !== 0) {
            throw new Error(
                `Banco recusado antes do backfill: quick_check=${integrityBefore.quickCheck}, ` +
                `foreign_keys=${integrityBefore.foreignKeyViolations}.`
            );
        }

        const preview = await planQuickEvaluationStarBackfill(db);
        if (!apply) {
            console.log(JSON.stringify({
                mode: 'preview',
                ...sanitizedPlan(preview),
                integrityBefore,
            }, null, 2));
            return;
        }

        if (confirmation !== APPLY_CONFIRMATION) {
            throw new Error(`Aplicacao recusada: use --confirm=${APPLY_CONFIRMATION}.`);
        }
        if (expectedCandidates === null) {
            throw new Error('Aplicacao recusada: informe --expected-candidates=<valor observado no preview>.');
        }
        if (preview.candidateCount !== expectedCandidates) {
            throw new Error(
                `Aplicacao recusada: preview atual tem ${preview.candidateCount} candidato(s), ` +
                `mas --expected-candidates=${expectedCandidates}.`
            );
        }
        if (!preview.schemaReady || preview.invalidCount > 0) {
            throw new Error(
                `Aplicacao recusada: schemaReady=${preview.schemaReady}, invalid=${preview.invalidCount}.`
            );
        }

        const result = await applyQuickEvaluationStarBackfill(db, { apply: true });
        const integrityAfter = await verifyDatabase(db);
        const output = {
            mode: 'apply',
            ...sanitizedPlan(result),
            applied: result.applied,
            appliedCount: result.appliedCount || 0,
            integrityBefore,
            integrityAfter,
        };
        console.log(JSON.stringify(output, null, 2));

        if (integrityAfter.quickCheck !== 'ok' || integrityAfter.foreignKeyViolations !== 0) {
            process.exitCode = 2;
        }
    } finally {
        await db.close();
    }
}

main().catch((error) => {
    const code = error?.code ? ` (${error.code})` : '';
    console.error(`[season-stars-backfill]${code} ${error?.message || error}`);
    process.exitCode = 1;
});
