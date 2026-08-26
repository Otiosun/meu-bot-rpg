'use strict';

function readItemField(item, snake, camel) {
    return item?.[snake] ?? item?.[camel] ?? null;
}

function parseBeforeSnapshot(raw) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
    if (typeof raw !== 'string' || !raw.trim()) return null;
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (_) {
        return null;
    }
}

function inspectChildResetEventBinding(item, event, { snapshotHash } = {}) {
    if (typeof snapshotHash !== 'function') {
        throw new TypeError('snapshotHash canônico obrigatório para validar child event.');
    }

    const expectedOperationCode = String(readItemField(item, 'reset_operation_code', 'resetOperationCode') || '');
    const expectedPlayerId = String(readItemField(item, 'player_id', 'playerId') || '');
    const expectedSnapshotSha256 = String(readItemField(item, 'planned_snapshot_sha256', 'snapshotSha256') || '');

    if (!event) {
        return { ok: false, code: 'event_missing', expectedOperationCode, expectedPlayerId };
    }
    if (String(event.operation_code || '') !== expectedOperationCode) {
        return {
            ok: false,
            code: 'operation_code_mismatch',
            expectedOperationCode,
            observedOperationCode: event.operation_code || null,
            expectedPlayerId,
        };
    }
    if (String(event.player_id || '') !== expectedPlayerId) {
        return {
            ok: false,
            code: 'player_mismatch',
            expectedOperationCode,
            expectedPlayerId,
            observedPlayerId: event.player_id || null,
        };
    }
    if (String(event.status || '') !== 'applied') {
        return {
            ok: false,
            code: 'status_mismatch',
            expectedOperationCode,
            expectedPlayerId,
            observedStatus: event.status || null,
        };
    }
    if (String(event.scope || '') !== 'character') {
        return {
            ok: false,
            code: 'scope_mismatch',
            expectedOperationCode,
            expectedPlayerId,
            observedScope: event.scope || null,
        };
    }
    if (!expectedSnapshotSha256) {
        return {
            ok: false,
            code: 'planned_snapshot_hash_missing',
            expectedOperationCode,
            expectedPlayerId,
        };
    }

    const beforeSnapshot = parseBeforeSnapshot(event.before_json);
    if (!beforeSnapshot) {
        return {
            ok: false,
            code: 'before_snapshot_invalid',
            expectedOperationCode,
            expectedPlayerId,
            expectedSnapshotSha256,
        };
    }
    const observedSnapshotSha256 = snapshotHash(beforeSnapshot);
    if (observedSnapshotSha256 !== expectedSnapshotSha256) {
        return {
            ok: false,
            code: 'before_snapshot_mismatch',
            expectedOperationCode,
            expectedPlayerId,
            expectedSnapshotSha256,
            observedSnapshotSha256,
        };
    }

    return {
        ok: true,
        code: 'bound',
        expectedOperationCode,
        expectedPlayerId,
        expectedSnapshotSha256,
        observedSnapshotSha256,
    };
}

module.exports = {
    inspectChildResetEventBinding,
    parseBeforeSnapshot,
};
