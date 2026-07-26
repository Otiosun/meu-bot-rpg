'use strict';

const {
    FIXED_TRAIT_SLOTS,
    ensureAdminTraitSchema,
    getTraitTemplate,
    normalizeSlot,
    slugifyTraitKey,
} = require('./adminTraitService');

const OVERRIDE_KEY = 'traitOverride';
const OVERRIDE_AUDIT_KEY = 'traitOverrideAudit';
const OVERRIDE_FIELDS = Object.freeze([
    'name',
    'description',
    'effectText',
    'restrictionsText',
    'imageUrl',
]);

class AdminTraitOverrideError extends Error {
    constructor(code, message, status = 400, details = null) {
        super(message || code);
        this.name = 'AdminTraitOverrideError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

function parseJson(value, fallback = {}) {
    if (!value) return fallback;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function object(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function textOrNull(value) {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return text || null;
}

function safeImage(value) {
    const image = textOrNull(value);
    if (!image) return null;
    if (/^https:\/\//i.test(image)) return image;
    if (/^\/[^/]/.test(image)) return image;
    if (/^data:image\/(?:png|jpe?g|webp);base64,/i.test(image)) return image;
    throw new AdminTraitOverrideError(
        'invalid_trait_override_image',
        'A imagem personalizada precisa usar HTTPS, caminho interno ou Data URL PNG/JPEG/WEBP.',
        400,
    );
}

function normalizeOverridePayload(payload = {}, options = {}) {
    const container = object(payload);
    const source = object(container.override) !== container && Object.keys(object(container.override)).length
        ? object(container.override)
        : container;
    const override = {};
    const aliases = {
        name: ['name', 'nome', 'title'],
        description: ['description', 'descricao'],
        effectText: ['effectText', 'effect_text', 'effect', 'efeito'],
        restrictionsText: ['restrictionsText', 'restrictions_text', 'restrictions', 'restricoes'],
        imageUrl: ['imageUrl', 'image_url', 'image'],
    };

    for (const field of OVERRIDE_FIELDS) {
        const key = aliases[field].find((candidate) => Object.prototype.hasOwnProperty.call(source, candidate));
        if (!key) continue;
        const value = field === 'imageUrl' ? safeImage(source[key]) : textOrNull(source[key]);
        if (value) override[field] = value;
    }

    if (!options.allowEmpty && !Object.keys(override).length) {
        throw new AdminTraitOverrideError(
            'empty_trait_override',
            'Informe pelo menos um nome, descrição, efeito, restrição ou imagem personalizada.',
            400,
        );
    }
    return override;
}

function readTraitOverride(metadata = {}) {
    const raw = object(metadata)[OVERRIDE_KEY];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return normalizeOverridePayload({ override: raw }, { allowEmpty: true });
}

function mergeTraitOverride(trait, metadata = {}) {
    if (!trait) return null;
    const baseMetadata = object(trait.metadata);
    const override = readTraitOverride(metadata);
    const personalized = Object.keys(override).length > 0;
    const mergedMetadata = { ...baseMetadata };
    if (override.imageUrl) mergedMetadata.imageUrl = override.imageUrl;

    return {
        ...trait,
        name: override.name ?? trait.name,
        description: override.description ?? trait.description ?? null,
        effectText: override.effectText ?? trait.effectText ?? null,
        restrictionsText: override.restrictionsText ?? trait.restrictionsText ?? null,
        metadata: mergedMetadata,
        personalized,
        override,
    };
}

async function findTraitTemplateByLegacyValue(db, slotKey, value) {
    await ensureAdminTraitSchema(db);
    const slot = normalizeSlot(slotKey);
    const name = textOrNull(value);
    if (!name) return null;
    const canonicalKey = slugifyTraitKey(name);
    const row = await db.get(
        `SELECT id
         FROM clover_trait_templates
         WHERE slot_key = ?
           AND status = 'active'
           AND (canonical_key = ? OR LOWER(name) = LOWER(?))
         ORDER BY CASE WHEN canonical_key = ? THEN 0 ELSE 1 END, version DESC, id ASC
         LIMIT 1`,
        [slot, canonicalKey, name, canonicalKey],
    );
    return row?.id ? getTraitTemplate(db, row.id, { nullIfMissing: true }) : null;
}

function assignmentSnapshot(context) {
    return {
        playerId: context.playerId,
        characterName: context.characterName,
        assignmentId: context.row?.id || null,
        assignmentExisted: Boolean(context.row),
        slotKey: context.slotKey,
        traitId: context.trait.id,
        value: context.value,
        metadata: { ...context.metadata },
        override: readTraitOverride(context.metadata),
        trait: mergeTraitOverride(context.trait, context.metadata),
    };
}

async function loadAssignmentContext(db, target, action = {}) {
    await ensureAdminTraitSchema(db);
    const playerId = String(target?.playerId || '').trim();
    if (!playerId) {
        throw new AdminTraitOverrideError('missing_player_id', 'Jogador alvo não informado.', 400);
    }

    const assignmentId = Number(action.payload?.assignmentId || action.payload?.assignment_id || 0);
    let row = null;
    let slotKey = null;
    let player = null;

    if (Number.isInteger(assignmentId) && assignmentId > 0) {
        row = await db.get(
            `SELECT * FROM clover_player_traits
             WHERE id = ? AND player_id = ? AND active = 1`,
            [assignmentId, playerId],
        );
        if (!row) {
            throw new AdminTraitOverrideError(
                'trait_assignment_not_found',
                'O vínculo de Traço não foi encontrado para este jogador.',
                404,
                { playerId, assignmentId },
            );
        }
        slotKey = normalizeSlot(row.slot_key);
        player = await db.get('SELECT id, personagem_nome FROM jogadores WHERE id = ?', [playerId]);
    } else {
        slotKey = normalizeSlot(action.payload?.slotKey || action.payload?.slot_key, { fixedOnly: true });
        player = await db.get(
            `SELECT id, personagem_nome, ${slotKey} AS value
             FROM jogadores WHERE id = ?`,
            [playerId],
        );
        if (!player) {
            throw new AdminTraitOverrideError('player_not_found', 'Jogador não encontrado.', 404, { playerId });
        }
        row = await db.get(
            `SELECT * FROM clover_player_traits
             WHERE player_id = ? AND slot_key = ? AND active = 1
             ORDER BY id DESC LIMIT 1`,
            [playerId, slotKey],
        );
    }

    if (!player) {
        throw new AdminTraitOverrideError('player_not_found', 'Jogador não encontrado.', 404, { playerId });
    }

    const value = textOrNull(row?.value_text ?? player.value);
    const trait = row?.trait_id
        ? await getTraitTemplate(db, row.trait_id, { nullIfMissing: true })
        : await findTraitTemplateByLegacyValue(db, slotKey, value);
    if (!trait) {
        throw new AdminTraitOverrideError(
            'trait_template_required',
            'Este registro ainda não está ligado a um modelo do catálogo. Cadastre ou vincule o modelo antes de personalizar.',
            409,
            { playerId, slotKey, value },
        );
    }

    return {
        playerId,
        characterName: player.personagem_nome || player.id,
        row,
        slotKey,
        value: value || trait.name,
        trait,
        metadata: parseJson(row?.metadata_json, {}),
    };
}

function metadataWithOverride(metadata, override, operation) {
    return {
        ...object(metadata),
        [OVERRIDE_KEY]: { ...override },
        [OVERRIDE_AUDIT_KEY]: {
            operationCode: operation.code,
            actorId: operation.actor.id,
            updatedAt: new Date().toISOString(),
            action: 'customize',
        },
    };
}

function metadataWithoutOverride(metadata, operation) {
    const next = { ...object(metadata) };
    delete next[OVERRIDE_KEY];
    next[OVERRIDE_AUDIT_KEY] = {
        operationCode: operation.code,
        actorId: operation.actor.id,
        updatedAt: new Date().toISOString(),
        action: 'reset',
    };
    return next;
}

async function assertOverrideOperationCurrent(db, assignmentId, operationCode) {
    const row = await db.get('SELECT metadata_json FROM clover_player_traits WHERE id = ?', [assignmentId]);
    if (!row) return;
    const metadata = parseJson(row.metadata_json, {});
    const currentCode = object(metadata[OVERRIDE_AUDIT_KEY]).operationCode;
    if (currentCode && currentCode !== operationCode) {
        throw new AdminTraitOverrideError(
            'trait_override_changed_since_apply',
            'A personalização recebeu outra alteração depois desta operação e não pode ser desfeita automaticamente.',
            409,
            { assignmentId, currentOperationCode: currentCode },
        );
    }
}

async function persistCustomization(db, context, override, operation) {
    const metadata = metadataWithOverride(context.metadata, override, operation);
    if (context.row) {
        await db.run(
            'UPDATE clover_player_traits SET metadata_json = ? WHERE id = ? AND player_id = ? AND active = 1',
            [JSON.stringify(metadata), context.row.id, context.playerId],
        );
        return { assignmentId: context.row.id, createdAssignment: false, metadata };
    }

    if (!FIXED_TRAIT_SLOTS.includes(context.slotKey)) {
        throw new AdminTraitOverrideError('trait_assignment_required', 'O vínculo adicional precisa existir antes da personalização.', 409);
    }
    const timestamp = new Date().toISOString();
    const inserted = await db.run(
        `INSERT INTO clover_player_traits
         (player_id, trait_id, slot_key, value_text, active, operation_code, assigned_by,
          metadata_json, assigned_at, position, source, legacy_ref, assignment_key)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 0, 'admin_override_link', ?, ?)`,
        [
            context.playerId,
            context.trait.id,
            context.slotKey,
            context.value,
            operation.code,
            operation.actor.id,
            JSON.stringify({ ...metadata, linkedLegacyByOverride: true }),
            timestamp,
            `jogadores.${context.slotKey}`,
            `override-link:${operation.code}:${context.playerId}:${context.slotKey}`,
        ],
    );
    return {
        assignmentId: Number(inserted.lastID),
        createdAssignment: true,
        metadata: { ...metadata, linkedLegacyByOverride: true },
    };
}

function createTraitOverrideExecutors() {
    return {
        'player.trait.customize': {
            async preview({ db, action, target }) {
                const context = await loadAssignmentContext(db, target, action);
                const before = assignmentSnapshot(context);
                const override = normalizeOverridePayload(action.payload || {});
                const afterMetadata = metadataWithOverride(context.metadata, override, {
                    code: 'PREVIEW',
                    actor: { id: 'preview' },
                });
                return {
                    summary: `${context.characterName}: personalizar ${context.trait.name}`,
                    before,
                    after: {
                        ...before,
                        override,
                        trait: mergeTraitOverride(context.trait, afterMetadata),
                    },
                };
            },
            async apply({ db, operation, action, target, before, after }) {
                const context = await loadAssignmentContext(db, target, action);
                const override = normalizeOverridePayload(action.payload || {});
                const persisted = await persistCustomization(db, context, override, operation);
                return {
                    before,
                    after: {
                        ...after,
                        ...persisted,
                        trait: mergeTraitOverride(context.trait, persisted.metadata),
                    },
                    summary: `${context.characterName}: personalização de ${context.trait.name} aplicada.`,
                };
            },
            async undo({ db, operation, before, after }) {
                const assignmentId = Number(after?.assignmentId || before?.assignmentId || 0);
                if (!assignmentId) {
                    throw new AdminTraitOverrideError('missing_trait_assignment_snapshot', 'Snapshot do vínculo personalizado está incompleto.', 409);
                }
                await assertOverrideOperationCurrent(db, assignmentId, operation.code);
                if (after?.createdAssignment) {
                    await db.run('DELETE FROM clover_player_traits WHERE id = ?', [assignmentId]);
                    return;
                }
                await db.run(
                    'UPDATE clover_player_traits SET metadata_json = ? WHERE id = ?',
                    [JSON.stringify(before?.metadata || {}), assignmentId],
                );
            },
        },
        'player.trait.reset_override': {
            async preview({ db, action, target }) {
                const context = await loadAssignmentContext(db, target, action);
                if (!context.row) {
                    throw new AdminTraitOverrideError('trait_override_assignment_required', 'Não existe vínculo individual para restaurar.', 409);
                }
                const before = assignmentSnapshot(context);
                if (!Object.keys(before.override || {}).length) {
                    throw new AdminTraitOverrideError('trait_override_missing', 'Este Traço já usa integralmente o modelo do sistema.', 409);
                }
                return {
                    summary: `${context.characterName}: restaurar modelo de ${context.trait.name}`,
                    before,
                    after: {
                        ...before,
                        override: {},
                        trait: mergeTraitOverride(context.trait, {}),
                    },
                };
            },
            async apply({ db, operation, action, target, before, after }) {
                const context = await loadAssignmentContext(db, target, action);
                if (!context.row) {
                    throw new AdminTraitOverrideError('trait_override_assignment_required', 'Não existe vínculo individual para restaurar.', 409);
                }
                const metadata = metadataWithoutOverride(context.metadata, operation);
                await db.run(
                    'UPDATE clover_player_traits SET metadata_json = ? WHERE id = ? AND player_id = ? AND active = 1',
                    [JSON.stringify(metadata), context.row.id, context.playerId],
                );
                return {
                    before,
                    after: {
                        ...after,
                        assignmentId: context.row.id,
                        metadata,
                        trait: mergeTraitOverride(context.trait, metadata),
                    },
                    summary: `${context.characterName}: modelo de ${context.trait.name} restaurado.`,
                };
            },
            async undo({ db, operation, before, after }) {
                const assignmentId = Number(after?.assignmentId || before?.assignmentId || 0);
                if (!assignmentId) {
                    throw new AdminTraitOverrideError('missing_trait_assignment_snapshot', 'Snapshot do vínculo restaurado está incompleto.', 409);
                }
                await assertOverrideOperationCurrent(db, assignmentId, operation.code);
                await db.run(
                    'UPDATE clover_player_traits SET metadata_json = ? WHERE id = ?',
                    [JSON.stringify(before?.metadata || {}), assignmentId],
                );
            },
        },
    };
}

module.exports = {
    AdminTraitOverrideError,
    OVERRIDE_AUDIT_KEY,
    OVERRIDE_FIELDS,
    OVERRIDE_KEY,
    createTraitOverrideExecutors,
    findTraitTemplateByLegacyValue,
    mergeTraitOverride,
    normalizeOverridePayload,
    readTraitOverride,
};
