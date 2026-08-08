'use strict';

const {
    SPELL_TYPES,
    ensureSpellbookSchema,
    findSpell,
    getQueuePosition,
    listApprovedSpells,
    normalizeSpellName,
    saveSpell,
} = require('./spellbookService');
const { getSpellCapacity } = require('./spellCapacityService');
const { inspectApprovalRequest } = require('./spellApprovalService');
const {
    concludeSpellReviewEntry,
    ensureSpellReviewFlowSchema,
    findActiveEntryForPlayer,
} = require('./spellReviewFlowService');

class AdminSpellError extends Error {
    constructor(code, message, status = 400, details = null) {
        super(message || code);
        this.name = 'AdminSpellError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function valuesMatch(left, right) {
    return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function clean(value, fallback = '-') {
    const text = String(value ?? '').trim();
    return text || fallback;
}

function normalizeType(value) {
    const key = String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase();
    const aliases = {
        criacao: 'Criação',
        reforco: 'Reforço',
        suporte: 'Suporte',
        misto: 'Misto',
        hibrido: 'Misto',
    };
    return aliases[key] || null;
}

function spellSnapshot(row) {
    if (!row) return null;
    return {
        id: Number(row.id || 0),
        name: clean(row.name, 'Feitiço sem nome'),
        normalizedName: clean(row.normalized_name, ''),
        version: Math.max(1, Number(row.version || 1)),
        type: clean(row.type),
        cost: clean(row.cost),
        reach: clean(row.reach),
        duration: clean(row.duration),
        effect: clean(row.effect),
        limits: clean(row.limits),
        admNotes: clean(row.adm_notes),
        status: clean(row.status, 'approved'),
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null,
        removedAt: row.removed_at || null,
    };
}

function queueSnapshot(row) {
    if (!row) return null;
    return {
        id: Number(row.id || 0),
        status: row.status || null,
        reviewState: row.review_state || 'active',
        requestedAt: row.requested_at || null,
        calledAt: row.called_at || null,
        closedAt: row.closed_at || null,
        closedBy: row.closed_by || null,
        reason: row.reason || null,
        heldAt: row.held_at || null,
        heldBy: row.held_by || null,
        holdReason: row.hold_reason || null,
    };
}

function approvalSheet(payload = {}) {
    const source = payload.spell && typeof payload.spell === 'object' ? payload.spell : payload;
    const name = clean(source.name || source.nome, '');
    const normalizedName = normalizeSpellName(name);
    const type = normalizeType(source.type || source.tipo);
    const sheet = {
        name,
        normalizedName,
        version: null,
        type,
        cost: clean(source.cost || source.custo, ''),
        reach: clean(source.reach || source.alcance, ''),
        duration: clean(source.duration || source.duracao || source.duração, ''),
        effect: clean(source.effect || source.efeito || source.description || source.descricao, ''),
        limits: clean(source.limits || source.limites, ''),
        admNotes: clean(source.admNotes || source.adm_notes || source.notasAdm || source.notas_adm, '-'),
    };
    const missing = [];
    if (!sheet.normalizedName) missing.push('Nome');
    if (!sheet.type) missing.push(`Tipo (${SPELL_TYPES.join(' / ')})`);
    if (!sheet.cost) missing.push('Custo');
    if (!sheet.reach) missing.push('Alcance');
    if (!sheet.duration) missing.push('Duração');
    if (!sheet.effect) missing.push('Efeito');
    if (!sheet.limits) missing.push('Limites');
    if (missing.length) {
        throw new AdminSpellError('invalid_spell_sheet', `Ficha de feitiço incompleta: ${missing.join(', ')}.`, 400, { missing });
    }
    return sheet;
}

function approvalMode(payload = {}) {
    const value = String(payload.mode || payload.modo || 'add').trim().toLowerCase();
    if (['add', 'create', 'novo', 'adicionar', 'aprovar'].includes(value)) return 'add';
    if (['update', 'version', 'versao', 'versão', 'atualizar', 'evoluir'].includes(value)) return 'update';
    throw new AdminSpellError('invalid_spell_approval_mode', 'Modo de aprovação inválido. Use add ou update.', 400, { mode: value });
}

function actorId(operation = {}) {
    return operation.actor?.id
        || operation.actor_id
        || operation.created_by
        || operation.createdBy
        || operation.approved_by
        || operation.approvedBy
        || 'admin-operation';
}

async function listAllSpellVersions(db, playerId) {
    await ensureSpellbookSchema(db);
    const rows = await db.all(
        `SELECT * FROM clover_spellbook_spells
         WHERE player_id = ?
         ORDER BY name COLLATE NOCASE, version DESC, id DESC`,
        [playerId]
    );
    return rows.map(spellSnapshot);
}

async function readAdminPlayerSpellbook(db, playerId) {
    await ensureSpellReviewFlowSchema(db);
    const approved = await listApprovedSpells(db, playerId);
    const capacity = await getSpellCapacity(db, playerId);
    const versions = await listAllSpellVersions(db, playerId);
    const queueEntry = await findActiveEntryForPlayer(db, playerId);
    const queuePosition = queueEntry?.status === 'waiting'
        ? await getQueuePosition(db, queueEntry)
        : null;
    return {
        ok: true,
        totalApproved: approved.length,
        capacity,
        approved: approved.map(spellSnapshot),
        versions,
        review: queueEntry ? {
            ...queueSnapshot(queueEntry),
            position: queuePosition,
        } : null,
    };
}

async function getSpellRowsByName(db, playerId, normalizedName) {
    await ensureSpellbookSchema(db);
    return db.all(
        `SELECT * FROM clover_spellbook_spells
         WHERE player_id = ? AND normalized_name = ?
         ORDER BY version ASC, id ASC`,
        [playerId, normalizedName]
    );
}

async function assertApprovalPreviewStillCurrent(db, playerId, before) {
    const entry = await findActiveEntryForPlayer(db, playerId);
    if (!entry || Number(entry.id) !== Number(before.queue?.id) || entry.status !== 'called') {
        throw new AdminSpellError(
            'spell_review_changed_after_preview',
            'A chamada de avaliação mudou depois da prévia. Gere uma nova prévia.',
            409
        );
    }
    const rows = await getSpellRowsByName(db, playerId, before.spell.normalizedName);
    const currentVersions = rows.map(spellSnapshot);
    if (!valuesMatch(currentVersions, before.versions || [])) {
        throw new AdminSpellError(
            'spell_versions_changed_after_preview',
            'As versões deste feitiço mudaram depois da prévia. Gere uma nova prévia.',
            409
        );
    }
}

async function assertApprovedSpellUndoSafe(db, playerId, after) {
    const current = await db.get(
        'SELECT * FROM clover_spellbook_spells WHERE id = ? AND player_id = ?',
        [after.spell.id, playerId]
    );
    if (!current || !valuesMatch(spellSnapshot(current), after.spell)) {
        throw new AdminSpellError(
            'spell_changed_after_apply',
            'O feitiço recebeu alteração posterior e não pode ser desfeito automaticamente.',
            409
        );
    }
    const newer = await db.get(
        `SELECT id, version FROM clover_spellbook_spells
         WHERE player_id = ? AND normalized_name = ? AND version > ?
         ORDER BY version ASC LIMIT 1`,
        [playerId, after.spell.normalizedName, after.spell.version]
    );
    if (newer) {
        throw new AdminSpellError(
            'spell_has_newer_version',
            'Existe uma versão posterior deste feitiço; o undo automático foi bloqueado.',
            409,
            { newerVersion: Number(newer.version) }
        );
    }
    const queue = await db.get('SELECT * FROM clover_spell_review_queue WHERE id = ?', [after.queue.id]);
    if (!queue || !valuesMatch(queueSnapshot(queue), after.queue)) {
        throw new AdminSpellError(
            'spell_review_changed_after_apply',
            'A entrada da avaliação mudou depois da aprovação; o undo automático foi bloqueado.',
            409
        );
    }
}

async function restoreQueueSnapshot(db, snapshot) {
    await db.run(
        `UPDATE clover_spell_review_queue
         SET status = ?, review_state = ?, requested_at = ?, called_at = ?, closed_at = ?,
             closed_by = ?, reason = ?, held_at = ?, held_by = ?, hold_reason = ?
         WHERE id = ?`,
        [
            snapshot.status,
            snapshot.reviewState || 'active',
            snapshot.requestedAt,
            snapshot.calledAt,
            snapshot.closedAt,
            snapshot.closedBy,
            snapshot.reason,
            snapshot.heldAt,
            snapshot.heldBy,
            snapshot.holdReason,
            snapshot.id,
        ]
    );
}

function createSpellExecutors() {
    return {
        'player.spell.approve': {
            async preview({ db, action, target }) {
                const mode = approvalMode(action.payload || {});
                const sheet = approvalSheet(action.payload || {});
                const inspection = await inspectApprovalRequest(db, target.playerId, sheet, {
                    nextVersion: mode === 'update',
                });
                if (!inspection.ok) {
                    throw new AdminSpellError(
                        inspection.code,
                        inspection.code === 'queue_entry_not_active'
                            ? 'O personagem não possui avaliação de feitiço ativa.'
                            : inspection.code === 'queue_entry_not_called'
                                ? 'O personagem ainda não foi chamado para avaliação.'
                                : inspection.code === 'spell_capacity_full'
                                    ? 'O personagem não possui slot disponível para um novo feitiço.'
                                    : 'A aprovação do feitiço não pode ser simulada.',
                        409,
                        inspection
                    );
                }
                const rows = await getSpellRowsByName(db, target.playerId, sheet.normalizedName);
                const latestVersion = rows.reduce((max, row) => Math.max(max, Number(row.version || 0)), 0);
                const expectedVersion = mode === 'update' ? latestVersion + 1 : 1;
                return {
                    summary: `${target.characterName || 'Personagem'}: aprovar ${sheet.name} v${expectedVersion}`,
                    before: {
                        queue: queueSnapshot(inspection.entry),
                        versions: rows.map(spellSnapshot),
                        spell: sheet,
                        capacity: inspection.capacity,
                        mode,
                    },
                    after: {
                        spell: { ...sheet, version: expectedVersion, status: 'approved' },
                        queue: { ...queueSnapshot(inspection.entry), status: 'concluded' },
                    },
                };
            },
            async apply({ db, operation, target, before }) {
                await assertApprovalPreviewStillCurrent(db, target.playerId, before);
                const inspection = await inspectApprovalRequest(db, target.playerId, before.spell, {
                    nextVersion: before.mode === 'update',
                });
                if (!inspection.ok) {
                    throw new AdminSpellError(inspection.code, 'A aprovação deixou de ser válida depois da prévia.', 409, inspection);
                }
                const adminId = actorId(operation);
                const saved = await saveSpell(db, target.playerId, before.spell, adminId, {
                    nextVersion: before.mode === 'update',
                });
                if (!saved.ok) {
                    throw new AdminSpellError(saved.code || 'spell_save_failed', 'Não foi possível salvar a versão aprovada.', 409, saved);
                }
                const concluded = await concludeSpellReviewEntry(
                    db,
                    target.playerId,
                    adminId,
                    `feitiço ${saved.spell.name} v${saved.spell.version} aprovado pela Central ADM`
                );
                if (!concluded.ok) {
                    throw new AdminSpellError(
                        concluded.code || 'queue_conclusion_failed',
                        'Não foi possível concluir a avaliação na mesma operação.',
                        409,
                        concluded
                    );
                }
                return {
                    after: {
                        spell: spellSnapshot(saved.spell),
                        queue: queueSnapshot(concluded.entry),
                    },
                    summary: `${target.characterName || 'Personagem'}: ${saved.spell.name} v${saved.spell.version} aprovado.`,
                };
            },
            async undo({ db, target, before, after }) {
                await assertApprovedSpellUndoSafe(db, target.playerId, after);
                await db.run(
                    'DELETE FROM clover_spellbook_spells WHERE id = ? AND player_id = ?',
                    [after.spell.id, target.playerId]
                );
                await restoreQueueSnapshot(db, before.queue);
            },
        },

        'player.spell.remove': {
            async preview({ db, action, target }) {
                const query = clean(action.payload?.name || action.payload?.nome || action.payload?.query, '');
                if (!query) throw new AdminSpellError('missing_spell_query', 'Informe o feitiço que será removido.');
                const found = await findSpell(db, target.playerId, query);
                if (!found.ok) {
                    throw new AdminSpellError(
                        found.code || 'spell_not_found',
                        found.code === 'ambiguous'
                            ? 'Há mais de um feitiço compatível com essa busca.'
                            : 'Feitiço não encontrado no grimório.',
                        found.code === 'ambiguous' ? 409 : 404,
                        found
                    );
                }
                const rows = await getSpellRowsByName(db, target.playerId, found.spell.normalized_name);
                const active = rows.filter((row) => row.status === 'approved' && !row.removed_at);
                return {
                    summary: `${target.characterName || 'Personagem'}: remover ${found.spell.name}`,
                    before: {
                        normalizedName: found.spell.normalized_name,
                        versions: active.map(spellSnapshot),
                    },
                    after: {
                        normalizedName: found.spell.normalized_name,
                        removedVersions: active.map((row) => ({ ...spellSnapshot(row), status: 'removed' })),
                    },
                };
            },
            async apply({ db, operation, target, before }) {
                const currentRows = (await getSpellRowsByName(db, target.playerId, before.normalizedName))
                    .filter((row) => row.status === 'approved' && !row.removed_at)
                    .map(spellSnapshot);
                if (!valuesMatch(currentRows, before.versions)) {
                    throw new AdminSpellError(
                        'spell_versions_changed_after_preview',
                        'O grimório mudou depois da prévia. Gere uma nova prévia.',
                        409
                    );
                }
                const adminId = actorId(operation);
                await db.run(
                    `UPDATE clover_spellbook_spells
                     SET status = 'removed', removed_at = CURRENT_TIMESTAMP,
                         updated_at = CURRENT_TIMESTAMP, updated_by = ?
                     WHERE player_id = ? AND normalized_name = ?
                       AND status = 'approved' AND removed_at IS NULL`,
                    [adminId, target.playerId, before.normalizedName]
                );
                const afterRows = (await getSpellRowsByName(db, target.playerId, before.normalizedName))
                    .filter((row) => row.status === 'removed')
                    .map(spellSnapshot);
                return {
                    after: {
                        normalizedName: before.normalizedName,
                        removedVersions: afterRows,
                    },
                    summary: `${target.characterName || 'Personagem'}: feitiço removido do grimório.`,
                };
            },
            async undo({ db, target, before, after }) {
                const rows = await getSpellRowsByName(db, target.playerId, before.normalizedName);
                const currentRemoved = rows.filter((row) => row.status === 'removed').map(spellSnapshot);
                if (!valuesMatch(currentRemoved, after.removedVersions)) {
                    throw new AdminSpellError(
                        'spell_changed_after_remove',
                        'As versões removidas mudaram depois da operação; o undo automático foi bloqueado.',
                        409
                    );
                }
                const beforeById = new Map(before.versions.map((row) => [Number(row.id), row]));
                for (const row of after.removedVersions) {
                    const original = beforeById.get(Number(row.id));
                    if (!original) continue;
                    await db.run(
                        `UPDATE clover_spellbook_spells
                         SET status = ?, removed_at = ?, updated_at = ?
                         WHERE id = ? AND player_id = ?`,
                        [original.status, original.removedAt, original.updatedAt, original.id, target.playerId]
                    );
                }
            },
        },
    };
}

module.exports = {
    AdminSpellError,
    approvalMode,
    approvalSheet,
    createSpellExecutors,
    listAllSpellVersions,
    queueSnapshot,
    readAdminPlayerSpellbook,
    spellSnapshot,
};