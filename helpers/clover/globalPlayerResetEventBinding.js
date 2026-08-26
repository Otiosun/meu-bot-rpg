'use strict';

const { isOwner } = require('../groupAccess');
const { snapshotHash } = require('./resetSnapshotIntegrity');

function readItemField(item, snake, camel) {
    return item?.[snake] ?? item?.[camel] ?? null;
}

function parseObjectJson(raw) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
    if (typeof raw !== 'string' || !raw.trim()) return null;
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (_) {
        return null;
    }
}

function parseBeforeSnapshot(raw) {
    return parseObjectJson(raw);
}

function inspectAfterResetSnapshot(snapshot, expectedPlayerId) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
        return { ok: false, code: 'child_event_after_json_invalid' };
    }
    const player = snapshot.player;
    if (!player || typeof player !== 'object' || Array.isArray(player)) {
        return { ok: false, code: 'child_event_after_player_missing' };
    }
    if (String(player.id || '') !== String(expectedPlayerId || '')) {
        return {
            ok: false,
            code: 'child_event_after_player_mismatch',
            expectedPlayerId,
            observedPlayerId: player.id || null,
        };
    }
    if (String(player.personagem_nome ?? '').trim() !== '-') {
        return {
            ok: false,
            code: 'child_event_after_character_not_reset',
            expectedPlayerId,
            observedCharacter: player.personagem_nome ?? null,
        };
    }
    if (Object.prototype.hasOwnProperty.call(player, 'jogo_status') && String(player.jogo_status || '') !== 'bloqueado') {
        return {
            ok: false,
            code: 'child_event_after_game_not_blocked',
            expectedPlayerId,
            observedGameStatus: player.jogo_status ?? null,
        };
    }

    const tables = snapshot.tables;
    if (!tables || typeof tables !== 'object' || Array.isArray(tables)) {
        return { ok: false, code: 'child_event_after_tables_invalid', expectedPlayerId };
    }
    for (const [tableName, rows] of Object.entries(tables)) {
        if (!Array.isArray(rows) || rows.length !== 0) {
            return {
                ok: false,
                code: 'child_event_after_reset_rows_remaining',
                expectedPlayerId,
                tableName,
                rowCount: Array.isArray(rows) ? rows.length : null,
            };
        }
    }

    for (const field of ['queueEntries', 'reservations', 'leadership']) {
        if (!Array.isArray(snapshot[field]) || snapshot[field].length !== 0) {
            return {
                ok: false,
                code: `child_event_after_${field}_not_clear`,
                expectedPlayerId,
                observedCount: Array.isArray(snapshot[field]) ? snapshot[field].length : null,
            };
        }
    }
    return { ok: true, code: 'child_event_after_reset_valid', expectedPlayerId };
}

function inspectChildResetEventBinding(item, event, { expectedReason } = {}) {
    const expectedOperationCode = String(readItemField(item, 'reset_operation_code', 'resetOperationCode') || '');
    const expectedPlayerId = String(readItemField(item, 'player_id', 'playerId') || '');
    const expectedSnapshotSha256 = String(readItemField(item, 'planned_snapshot_sha256', 'snapshotSha256') || '');
    const frozenReason = String(expectedReason || '').trim();

    if (!item || !event) {
        return { ok: false, code: 'child_event_missing_context', expectedOperationCode, expectedPlayerId };
    }
    if (!frozenReason) {
        return {
            ok: false,
            code: 'child_event_expected_reason_missing',
            expectedOperationCode,
            expectedPlayerId,
        };
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
    if (String(event.reason || '').trim() !== frozenReason) {
        return {
            ok: false,
            code: 'child_event_reason_mismatch',
            expectedOperationCode,
            expectedPlayerId,
            expectedReason: frozenReason,
            observedReason: event.reason ?? null,
        };
    }
    if (!isOwner(event.created_by)) {
        return {
            ok: false,
            code: 'child_event_creator_not_owner',
            expectedOperationCode,
            expectedPlayerId,
            observedCreatedBy: event.created_by ?? null,
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

    const beforeSnapshot = parseObjectJson(event.before_json);
    if (!beforeSnapshot) {
        return {
            ok: false,
            code: 'child_event_before_json_invalid',
            expectedOperationCode,
            expectedPlayerId,
            expectedSnapshotSha256,
        };
    }
    if (String(beforeSnapshot?.player?.id || '') !== expectedPlayerId) {
        return {
            ok: false,
            code: 'child_event_before_player_mismatch',
            expectedOperationCode,
            expectedPlayerId,
            observedPlayerId: beforeSnapshot?.player?.id ?? null,
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

    const afterSnapshot = parseObjectJson(event.after_json);
    const afterIntegrity = inspectAfterResetSnapshot(afterSnapshot, expectedPlayerId);
    if (!afterIntegrity.ok) {
        return {
            ok: false,
            code: afterIntegrity.code,
            expectedOperationCode,
            expectedPlayerId,
            afterIntegrity,
        };
    }

    const result = parseObjectJson(event.result_json);
    if (!result) {
        return {
            ok: false,
            code: 'child_event_result_json_invalid',
            expectedOperationCode,
            expectedPlayerId,
        };
    }
    if (result?.preserved?.playerId !== true || !Number.isFinite(Number(result.deletedRows)) || Number(result.deletedRows) < 0) {
        return {
            ok: false,
            code: 'child_event_result_semantics_invalid',
            expectedOperationCode,
            expectedPlayerId,
        };
    }

    return {
        ok: true,
        code: 'child_event_bound',
        expectedOperationCode,
        expectedPlayerId,
        expectedReason: frozenReason,
        expectedSnapshotSha256,
        observedSnapshotSha256,
        afterIntegrity,
    };
}

module.exports = {
    inspectAfterResetSnapshot,
    inspectChildResetEventBinding,
    parseBeforeSnapshot,
    parseObjectJson,
};
