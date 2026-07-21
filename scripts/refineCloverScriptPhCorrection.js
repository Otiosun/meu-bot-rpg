'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function replaceOnce(file, before, after) {
    const target = path.join(ROOT, file);
    const current = fs.readFileSync(target, 'utf8');
    const count = current.split(before).length - 1;
    if (count !== 1) {
        throw new Error(`${file}: esperado 1 trecho, encontrado ${count}`);
    }
    fs.writeFileSync(target, current.replace(before, after), 'utf8');
    console.log(`patched: ${file}`);
}

replaceOnce(
    'helpers/clover/phService.js',
`function removalAffectsAccumulated(source, metadata = {}) {
    if (metadata?.affect_accumulated === true || metadata?.affects_accumulated === true) {
        return true;
    }
    return String(source || '').trim().toLowerCase().startsWith('cloverscript');
}

async function removeAvailablePh(db, playerId, amount, source, reason, createdBy, metadata = {}) {
    const value = asIntegerAmount(amount);
    const correction = removalAffectsAccumulated(source, metadata);

    if (!correction) {
        return mutatePh(db, playerId, {
            amount: -Math.abs(value),
            kind: 'perda',
            source,
            reason: normalizeReason(reason),
            createdBy,
            metadata,
        });
    }

    const before = await getPhSummary(db, playerId);
    if (before.phAvailable < Math.abs(value)) {
        throw new PhServiceError('insufficient_ph', 'PH disponível insuficiente.');
    }
    if (before.phAccumulated < Math.abs(value)) {
        throw new PhServiceError('insufficient_accumulated_ph', 'PH acumulado insuficiente.');
    }

    await ensurePhState(db, playerId);
    return runLedgerMutation(db, playerId, {
        amount: -Math.abs(value),
        kind: 'ajuste_admin',
        source,
        reason: normalizeReason(reason),
        createdBy,
        metadata: {
            ...(metadata || {}),
            affects_accumulated: true,
            correction_scope: 'available_and_accumulated',
        },
    }, before);
}`,
`async function removeAvailablePh(db, playerId, amount, source, reason, createdBy, metadata = {}) {
    const value = asIntegerAmount(amount);
    return mutatePh(db, playerId, {
        amount: -Math.abs(value),
        kind: 'perda',
        source,
        reason: normalizeReason(reason),
        createdBy,
        metadata,
    });
}`
);

replaceOnce(
    'helpers/clover/cloverScriptService.js',
`const {
    addPh,
    getPhSummary,
    removeAvailablePh,
} = require('./phService');`,
`const {
    addPh,
    adminAdjustPh,
    getPhSummary,
} = require('./phService');`
);

replaceOnce(
    'helpers/clover/cloverScriptService.js',
`    const result = action.amount > 0
        ? await addPh(db, target.id, action.amount, \`cloverscript:\${action.source}\`, action.reason, ctx.actorId, metadata)
        : await removeAvailablePh(db, target.id, Math.abs(action.amount), 'cloverscript', action.reason, ctx.actorId, metadata);`,
`    const result = action.amount > 0
        ? await addPh(db, target.id, action.amount, \`cloverscript:\${action.source}\`, action.reason, ctx.actorId, metadata)
        : await adminAdjustPh(
            db,
            target.id,
            action.amount,
            action.reason,
            ctx.actorId,
            {
                source: \`cloverscript:\${action.source}\`,
                relatedId: \`cloverscript:\${run.id}:\${index}:\${target.id}\`,
                affectAccumulated: true,
                metadata: {
                    ...metadata,
                    correction_scope: 'available_and_accumulated',
                },
            }
        );`
);

replaceOnce(
    'tests/cloverScriptPhCorrection.test.js',
`    addPh,
    ensurePhState,
    getPhSummary,
    removeAvailablePh,`,
`    addPh,
    adminAdjustPh,
    ensurePhState,
    getPhSummary,
    removeAvailablePh,`
);

replaceOnce(
    'tests/cloverScriptPhCorrection.test.js',
`    const correction = await removeAvailablePh(
        db,
        'player@lid',
        40,
        'cloverscript',
        'correção administrativa',
        'owner@lid',
        { cloverscript_run_id: 99 }
    );`,
`    const correction = await adminAdjustPh(
        db,
        'player@lid',
        -40,
        'correção administrativa',
        'owner@lid',
        {
            source: 'cloverscript:outro',
            relatedId: 'cloverscript:99:1:player@lid',
            affectAccumulated: true,
            metadata: {
                cloverscript_run_id: 99,
                correction_scope: 'available_and_accumulated',
            },
        }
    );`
);

console.log('PH correction refined to explicit CloverScript admin adjustment.');
