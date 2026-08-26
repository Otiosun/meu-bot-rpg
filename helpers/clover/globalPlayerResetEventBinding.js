'use strict';

const { snapshotHash } = require('./resetSnapshotIntegrity');

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

function inspectChildResetEventBinding(item, event) {
    const expectedOperationCode = String(readItemField(item, 'reset_operation_code', 'resetOperationCode') || '');
    const expectedPlayerId = String(readItemField(item, 'player_id', 'playerId') || '');
    const expectedSnapshotSha256 = String(readItemField(item, 'planned_snapshot_sha256', 'snapshotSha256') || '');

    if (!item || !event) {
        return { ok: false, code: 'child_event_missing_context', expectedOperationCode, expectedPlayerId };
    }
    if (String(event.operation_code || '') !== expectedOperationCode) {
        return {
            ok: false,
            code: 'child_event_operation_code_mismatch',
            expectedOperationCode,
            observedOperationCode: event.operation_code || null,
            expectedPlayerId,
        };
    }
    if (String(event.player_id || '') !== expectedPlayerId) {
        return {
            ok: false,
            code: 'child_event_player_mismatch',
            expectedOperationCode,
            expectedPlayerId,
            observedPlayerId: event.player_id || null,
        };
    }
    if (String(event.status || '') !== 'applied') {
        return {
            ok: false,
            code: 'child_event_status_mismatch',
            expectedOperationCode,
            expectedPlayerId,
            observedStatus: event.status || null,
        };
    }
    if (String(event.scope || '') !== 'character') {
        return {
            ok: false,
            code: 'child_event_scope_mismatch',
            expectedOperationCode,
            expectedPlayerId,
            observedScope: event.scope || null,
        };
    }
    if (!expectedSnapshotSha256) {
        return {
            ok: false,
            code: 'child_event_snapshot_mismatch',
            expectedOperationCode,
            expectedPlayerId,
            expectedSnapshotSha256,
            observedSnapshotSha256: null,
        };
    }

    const beforeSnapshot = parseBeforeSnapshot(event.before_json);
    if (!beforeSnapshot) {
        return {
            ok: false,
            code: 'child_event_before_json_invalid',
            expectedOperationCode,
            expectedPlayerId,
            expectedSnapshotSha256,
        };
    }
    const observedSnapshotSha256 = snapshotHash(beforeSnapshot);
    if (observedSnapshotSha256 !== expectedSnapshotSha256) {
        return {
            ok: false,
            code: 'child_event_snapshot_mismatch',
            expectedOperationCode,
            expectedPlayerId,
            expectedSnapshotSha256,
            observedSnapshotSha256,
        };
    }

    return {
        ok: true,
        code: 'child_event_bound',
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
