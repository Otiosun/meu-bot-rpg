'use strict';

const crypto = require('crypto');
const { extractPhoneNumber } = require('../groupAccess');
const { equivalentPlayerIds } = require('./playerIdentityEquivalenceService');

const REFERENCE_RULES = new Map(Object.entries({
    'jogadores.id': 'source_record',
    'jogadores.canonical_player_id': 'repoint_to_canonical',
    'player_onboarding.player_id': 'merge_or_delete_auxiliary',
    'clover_character_stats.player_id': 'merge_singleton',
    'clover_mana_hexagon.player_id': 'merge_singleton',
    'clover_site_sessions.player_id': 'repoint_session',
    'clover_ph_ledger.player_id': 'repoint_history',
    'group_member_welcomes.player_id': 'repoint_history',
    'clover_quick_evaluations.player_id': 'repoint_history',
    'clover_script_actions.player_id': 'repoint_history',
    'clover_antighost_activity.player_id': 'repoint_history',
    'clover_antighost_events.player_id': 'repoint_history',
    'clover_delivery_jobs.target_jid': 'repoint_target',
    'clover_player_aliases.alias_value': 'preserve_alias_value',
    'clover_player_aliases.player_id_destino': 'repoint_alias_target',
    'clover_player_target_aliases.alias_label': 'preserve_alias_value',
    'clover_player_target_aliases.player_id': 'repoint_alias_target',
    'player_rolls.player_id': 'repoint_owned_data',
    'clover_trait_attempts.player_id': 'repoint_owned_data',
    'clover_inventory_items.player_id': 'repoint_owned_data',
    'clover_market_listings.seller_id': 'repoint_owned_data',
    'clover_raid_participants.player_id': 'repoint_owned_data',
}));

const ACTIVITY_SOURCES = Object.freeze([
    { table: 'player_rolls', column: 'player_id', substantive: true },
    { table: 'clover_trait_attempts', column: 'player_id', substantive: true },
    { table: 'clover_inventory_items', column: 'player_id', substantive: true },
    { table: 'clover_market_listings', column: 'seller_id', substantive: true },
    { table: 'clover_raid_participants', column: 'player_id', substantive: true },
    { table: 'clover_character_stats', column: 'player_id', substantive: false },
    { table: 'clover_site_sessions', column: 'player_id', substantive: false },
    { table: 'player_onboarding', column: 'player_id', substantive: false },
]);

const PLANNER_PASSIVE_STRATEGIES = new Set([
    'source_record',
    'preserve_alias_value',
    'merge_or_delete_auxiliary',
]);
const EXECUTOR_PASSIVE_STRATEGIES = new Set(['source_record', 'preserve_alias_value']);
const TECHNICAL_COLUMN = /^(?:__rowid__|rowid|id)$/i;
const TEMPORAL_COLUMN = /(?:^|_)(?:created|updated|sent|seen|processed|completed|confirmed|released|expired|deleted|welcomed|greeted|last)_at$/i;
const GENERIC_NAMES = new Set([
    '', '-', 'cacador', 'caçador', 'jogador', 'player', 'hunter',
    'sem identificacao', 'sem identificação',
]);

let previewCounter = 0;

class AdminIdentityRepairError extends Error {
    constructor(code, message, status = 400, details = null) {
        super(message || code);
        this.name = 'AdminIdentityRepairError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

function quoteIdentifier(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
}

function normalizeText(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase();
}

function hasFilledValue(value) {
    const text = String(value || '').trim();
    return Boolean(text) && text !== '-';
}

function isGenericName(value) {
    return GENERIC_NAMES.has(normalizeText(value));
}

function safeName(player) {
    for (const field of ['personagem_nome', 'nome', 'display_name', 'nome_real']) {
        const value = String(player?.[field] || '').trim();
        if (value && value !== '-') return value;
    }
    return String(player?.id || 'Sem identificação');
}

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, stable(value[key])])
    );
}

function fingerprint(value) {
    return crypto
        .createHash('sha256')
        .update(JSON.stringify(stable(value)))
        .digest('hex');
}

async function tableExists(db, table) {
    return Boolean(await db.get(
        `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`,
        [table]
    ).catch(() => null));
}

async function tableColumns(db, table) {
    if (!await tableExists(db, table)) return [];
    return db.all(`PRAGMA table_info(${quoteIdentifier(table)})`);
}

async function countValue(db, table, column, value) {
    if (!await tableExists(db, table)) return 0;
    const row = await db.get(
        `SELECT COUNT(*) AS total
         FROM ${quoteIdentifier(table)}
         WHERE ${quoteIdentifier(column)} = ?`,
        [value]
    );
    return Number(row?.total || 0);
}

function profileSignals(player) {
    const game = normalizeText(player.jogo_status);
    const profile = normalizeText(player.ficha_status);
    const history = normalizeText(player.historia_status);
    const appearance = normalizeText(player.personagem_aparencia_status);
    const approvedProfile = ['aprovada', 'aprovado', 'confirmada', 'confirmado'].includes(profile);
    const released = game === 'liberado';
    const approvedHistory = ['aprovada', 'aprovado'].includes(history);
    const approvedAppearance = ['approved', 'aprovada', 'aprovado'].includes(appearance);
    const meaningfulFields = ['personagem_nome', 'raca', 'classe', 'grimorio', 'magia']
        .filter((field) => hasFilledValue(player[field]) && !isGenericName(player[field]));
    const identityName = safeName(player);
    const meaningfulName = !isGenericName(identityName) && !identityName.includes('@');
    const meaningfulProfile = released
        || approvedProfile
        || approvedHistory
        || approvedAppearance
        || meaningfulFields.length > 0
        || meaningfulName;

    let score = 0;
    if (released) score += 1000;
    if (approvedProfile) score += 500;
    if (approvedHistory) score += 100;
    if (approvedAppearance) score += 100;
    score += meaningfulFields.length * 10;
    if (meaningfulName) score += 10;

    return {
        approvedProfile,
        released,
        approvedHistory,
        approvedAppearance,
        meaningfulFields,
        meaningfulName,
        meaningfulProfile,
        score,
    };
}

async function countActivity(db, source, playerId) {
    const columns = await tableColumns(db, source.table);
    if (!columns.some((column) => column.name === source.column)) return 0;
    const row = await db.get(
        `SELECT COUNT(*) AS total
         FROM ${quoteIdentifier(source.table)}
         WHERE ${quoteIdentifier(source.column)} = ?`,
        [playerId]
    );
    return Number(row?.total || 0);
}

async function inspectPlayer(db, player) {
    const activity = {};
    let substantiveActivityTotal = 0;
    let supportActivityTotal = 0;
    for (const source of ACTIVITY_SOURCES) {
        const total = await countActivity(db, source, player.id);
        activity[`${source.table}.${source.column}`] = total;
        if (source.substantive) substantiveActivityTotal += total;
        else supportActivityTotal += total;
    }
    const profile = profileSignals(player);
    return {
        id: player.id,
        name: safeName(player),
        profile,
        activity,
        substantiveActivityTotal,
        supportActivityTotal,
        hasSubstantiveData: substantiveActivityTotal > 0 || profile.meaningfulProfile,
        score: profile.score + substantiveActivityTotal * 25 + supportActivityTotal,
    };
}

function isScannableColumn(column) {
    const type = String(column?.type || '').trim().toUpperCase();
    if (!type) return true;
    return !/(BLOB|REAL|FLOA|DOUB|INT|NUM|DEC|BOOL|DATE|TIME)/.test(type);
}

function strategyFor(table, column) {
    return REFERENCE_RULES.get(`${table}.${column}`) || 'unknown';
}

async function discoverReferences(db, ids) {
    const references = new Map(ids.map((id) => [id, []]));
    const tables = await db.all(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name ASC`
    );

    for (const tableRow of tables) {
        const table = tableRow.name;
        const columns = await tableColumns(db, table);
        for (const column of columns.filter(isScannableColumn)) {
            const placeholders = ids.map(() => '?').join(', ');
            const matches = await db.all(
                `SELECT CAST(${quoteIdentifier(column.name)} AS TEXT) AS matched_id,
                        COUNT(*) AS total
                 FROM ${quoteIdentifier(table)}
                 WHERE CAST(${quoteIdentifier(column.name)} AS TEXT) IN (${placeholders})
                 GROUP BY CAST(${quoteIdentifier(column.name)} AS TEXT)`,
                ids
            ).catch(() => []);
            for (const match of matches) {
                if (!references.has(match.matched_id)) continue;
                references.get(match.matched_id).push({
                    table,
                    column: column.name,
                    rows: Number(match.total || 0),
                    strategy: strategyFor(table, column.name),
                });
            }
        }
    }
    return references;
}

function buildSource(sourceId, references) {
    const entries = references.get(sourceId) || [];
    return {
        sourceId,
        references: entries,
        rows: entries.reduce((sum, entry) => sum + entry.rows, 0),
        unknownReferences: entries.filter((entry) => entry.strategy === 'unknown'),
        activeMigrationReferences: entries.filter(
            (entry) => !PLANNER_PASSIVE_STRATEGIES.has(entry.strategy)
        ),
        preservedReferences: entries.filter(
            (entry) => entry.strategy === 'preserve_alias_value'
        ),
    };
}

async function assertEquivalentIdentity(db, source, canonical) {
    const sourceIds = new Set(await equivalentPlayerIds(db, source.id));
    const canonicalIds = new Set(await equivalentPlayerIds(db, canonical.id));
    const sourcePhone = extractPhoneNumber(source.id);
    const canonicalPhone = extractPhoneNumber(canonical.id);
    const explicitLink = String(source.canonical_player_id || '') === canonical.id
        || String(source.merged_into || '') === canonical.id
        || String(canonical.canonical_player_id || '') === source.id
        || String(canonical.merged_into || '') === source.id;
    const aliasLink = sourceIds.has(canonical.id) || canonicalIds.has(source.id);
    const samePhone = Boolean(sourcePhone && canonicalPhone && sourcePhone === canonicalPhone);

    if (!explicitLink && !aliasLink && !samePhone) {
        throw new AdminIdentityRepairError(
            'identity_not_equivalent',
            'Os dois cadastros não possuem vínculo canônico suficiente para consolidação automática.',
            409,
            {
                sourceId: source.id,
                canonicalId: canonical.id,
            }
        );
    }
}

async function buildLiveIdentityRepairPlan(db, sourceId, canonicalId) {
    const sourceKey = String(sourceId || '').trim();
    const canonicalKey = String(canonicalId || '').trim();
    if (!sourceKey || !canonicalKey || sourceKey === canonicalKey) {
        throw new AdminIdentityRepairError(
            'invalid_identity_repair_pair',
            'Informe um cadastro fonte e um cadastro canônico diferentes.',
            400
        );
    }

    const [source, canonical] = await Promise.all([
        db.get('SELECT * FROM jogadores WHERE id = ?', [sourceKey]),
        db.get('SELECT * FROM jogadores WHERE id = ?', [canonicalKey]),
    ]);
    if (!source) {
        throw new AdminIdentityRepairError(
            'identity_source_not_found',
            'Cadastro fonte não encontrado.',
            404,
            { sourceId: sourceKey }
        );
    }
    if (!canonical) {
        throw new AdminIdentityRepairError(
            'identity_canonical_not_found',
            'Cadastro canônico não encontrado.',
            404,
            { canonicalId: canonicalKey }
        );
    }

    await assertEquivalentIdentity(db, source, canonical);

    const [sourceInspection, canonicalInspection, references] = await Promise.all([
        inspectPlayer(db, source),
        inspectPlayer(db, canonical),
        discoverReferences(db, [sourceKey, canonicalKey]),
    ]);

    const sourceSubstantive = sourceInspection.hasSubstantiveData;
    const canonicalSubstantive = canonicalInspection.hasSubstantiveData;
    let action;
    let readyForExecutor = true;
    let dataOwnerId = canonicalKey;
    let reason;

    if (sourceSubstantive && canonicalSubstantive) {
        action = 'blocked_manual_merge';
        readyForExecutor = false;
        reason = 'Os dois cadastros possuem dados reais; a fusão automática não decide qual conteúdo vence.';
    } else if (sourceSubstantive && !canonicalSubstantive) {
        action = 'transactional_canonical_migration';
        dataOwnerId = sourceKey;
        reason = 'Os dados reais estão no cadastro fonte e serão promovidos ao ID canônico.';
    } else if (!sourceSubstantive && canonicalSubstantive) {
        action = 'transactional_alias_consolidation_ready';
        reason = 'Os dados reais já estão no cadastro canônico; referências do alias serão consolidadas.';
    } else {
        action = 'transactional_empty_cleanup_ready';
        reason = 'Os dois cadastros não possuem dados substantivos; a estrutura auxiliar pode ser consolidada.';
    }

    const sourcePlan = buildSource(sourceKey, references);
    if (sourcePlan.unknownReferences.length) {
        readyForExecutor = false;
        action = 'review_unknown_references';
        reason = 'O cadastro fonte possui referências sem estratégia de migração conhecida.';
    }

    const plan = {
        sourceId: sourceKey,
        canonicalId: canonicalKey,
        dataOwnerId,
        action,
        readyForExecutor,
        reason,
        source: sourceInspection,
        canonical: canonicalInspection,
        sourceReferences: sourcePlan,
        canonicalReferences: references.get(canonicalKey) || [],
    };
    return {
        ...plan,
        fingerprint: fingerprint(plan),
    };
}

function hasValue(value) {
    return value !== null && value !== undefined && String(value).trim() !== '';
}

function valuesEqual(left, right) {
    if (left === right) return true;
    if (!hasValue(left) && !hasValue(right)) return true;
    if (typeof left === 'number' && typeof right === 'number') {
        return Number(left) === Number(right);
    }
    return false;
}

function compactRow(row, columns) {
    const output = {};
    for (const column of columns) output[column] = row?.[column];
    return output;
}

async function uniqueIndexesContaining(db, table, targetColumn) {
    const indexes = await db.all(`PRAGMA index_list(${quoteIdentifier(table)})`);
    const result = [];
    for (const index of indexes) {
        if (Number(index.unique) !== 1) continue;
        const columns = (await db.all(
            `PRAGMA index_info(${quoteIdentifier(index.name)})`
        ))
            .sort((left, right) => Number(left.seqno) - Number(right.seqno))
            .map((entry) => entry.name)
            .filter(Boolean);
        if (!columns.includes(targetColumn)) continue;

        const partial = Number(index.partial || 0) === 1;
        let whereSql = null;
        if (partial) {
            const schema = await db.get(
                `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`,
                [index.name]
            );
            const match = /\bWHERE\b([\s\S]+)$/i.exec(String(schema?.sql || ''));
            whereSql = match?.[1]?.trim() || null;
            if (!whereSql) {
                throw new AdminIdentityRepairError(
                    'identity_partial_index_unreadable',
                    `Não foi possível interpretar o índice parcial ${index.name}.`,
                    409
                );
            }
        }
        result.push({ name: index.name, columns, partial, whereSql });
    }
    return result;
}

function buildCollisionPredicate(indexColumns, sourceRow, targetColumn, canonicalId) {
    const clauses = [];
    const params = [];
    for (const column of indexColumns) {
        const value = column === targetColumn ? canonicalId : sourceRow[column];
        if (value === null || value === undefined) return null;
        clauses.push(`${quoteIdentifier(column)} = ?`);
        params.push(value);
    }
    return { clauses, params };
}

async function sourceRowQualifiesForIndex(db, table, sourceRow, index) {
    if (!index.partial) return true;
    const row = await db.get(
        `SELECT CASE WHEN (${index.whereSql}) THEN 1 ELSE 0 END AS qualifies
         FROM ${quoteIdentifier(table)}
         WHERE rowid = ?`,
        [sourceRow.__rowid__]
    );
    return Number(row?.qualifies || 0) === 1;
}

async function findUniqueCollision(db, table, targetColumn, sourceRow, canonicalId, indexes) {
    const matches = new Map();
    for (const index of indexes) {
        if (!await sourceRowQualifiesForIndex(db, table, sourceRow, index)) continue;
        const predicate = buildCollisionPredicate(
            index.columns,
            sourceRow,
            targetColumn,
            canonicalId
        );
        if (!predicate) continue;
        const partialClause = index.partial ? ` AND (${index.whereSql})` : '';
        const row = await db.get(
            `SELECT rowid AS __rowid__, *
             FROM ${quoteIdentifier(table)}
             WHERE ${predicate.clauses.join(' AND ')}${partialClause}
             LIMIT 1`,
            predicate.params
        );
        if (row) matches.set(String(row.__rowid__), { row, index });
    }
    if (matches.size > 1) {
        throw new AdminIdentityRepairError(
            'identity_collision_ambiguous',
            `Colisão ambígua em ${table}.${targetColumn}.`,
            409
        );
    }
    return matches.size ? [...matches.values()][0] : null;
}

function shouldIgnoreSemanticColumn(column, primaryKeys, targetColumn) {
    return column === targetColumn
        || primaryKeys.has(column)
        || TECHNICAL_COLUMN.test(column)
        || TEMPORAL_COLUMN.test(column);
}

async function mergeEquivalentRows(
    db,
    table,
    targetColumn,
    sourceRow,
    canonicalRow,
    indexColumns
) {
    const columns = await tableColumns(db, table);
    const primaryKeys = new Set(
        columns.filter((column) => Number(column.pk) > 0).map((column) => column.name)
    );
    const updates = {};

    for (const column of columns.map((entry) => entry.name)) {
        if (shouldIgnoreSemanticColumn(column, primaryKeys, targetColumn)) continue;
        const sourceValue = sourceRow[column];
        const canonicalValue = canonicalRow[column];

        if (!hasValue(canonicalValue) && hasValue(sourceValue)) {
            updates[column] = sourceValue;
            continue;
        }
        if (
            hasValue(canonicalValue)
            && hasValue(sourceValue)
            && !valuesEqual(canonicalValue, sourceValue)
        ) {
            const relevant = [...new Set([...indexColumns, column])];
            throw new AdminIdentityRepairError(
                'identity_semantic_collision',
                `Conflito semântico em ${table}.${targetColumn}: ${column} diverge.`,
                409,
                {
                    source: compactRow(sourceRow, relevant),
                    canonical: compactRow(canonicalRow, relevant),
                }
            );
        }
    }

    const updateEntries = Object.entries(updates);
    if (updateEntries.length) {
        const assignments = updateEntries
            .map(([column]) => `${quoteIdentifier(column)} = ?`)
            .join(', ');
        await db.run(
            `UPDATE ${quoteIdentifier(table)}
             SET ${assignments}
             WHERE rowid = ?`,
            [...updateEntries.map(([, value]) => value), canonicalRow.__rowid__]
        );
    }

    const deleted = await db.run(
        `DELETE FROM ${quoteIdentifier(table)} WHERE rowid = ?`,
        [sourceRow.__rowid__]
    );
    return {
        changes: Number(deleted?.changes || 0) + updateEntries.length,
        deleted: Number(deleted?.changes || 0),
        mergedFields: updateEntries.length,
        mode: 'unique_equivalent_deduplicated',
    };
}

async function repointCollisionAware(db, table, column, sourceId, canonicalId) {
    const indexes = await uniqueIndexesContaining(db, table, column);
    if (!indexes.length) {
        return db.run(
            `UPDATE ${quoteIdentifier(table)}
             SET ${quoteIdentifier(column)} = ?
             WHERE ${quoteIdentifier(column)} = ?`,
            [canonicalId, sourceId]
        );
    }

    const sourceRows = await db.all(
        `SELECT rowid AS __rowid__, *
         FROM ${quoteIdentifier(table)}
         WHERE ${quoteIdentifier(column)} = ?
         ORDER BY rowid ASC`,
        [sourceId]
    );

    let moved = 0;
    let deduplicated = 0;
    let mergedFields = 0;
    for (const sourceRow of sourceRows) {
        const collision = await findUniqueCollision(
            db,
            table,
            column,
            sourceRow,
            canonicalId,
            indexes
        );
        if (!collision) {
            const result = await db.run(
                `UPDATE ${quoteIdentifier(table)}
                 SET ${quoteIdentifier(column)} = ?
                 WHERE rowid = ?`,
                [canonicalId, sourceRow.__rowid__]
            );
            moved += Number(result?.changes || 0);
            continue;
        }

        const result = await mergeEquivalentRows(
            db,
            table,
            column,
            sourceRow,
            collision.row,
            collision.index.columns
        );
        deduplicated += result.deleted || 0;
        mergedFields += result.mergedFields || 0;
    }

    return {
        changes: moved + deduplicated + mergedFields,
        moved,
        deduplicated,
        mergedFields,
        mode: 'collision_aware_repoint',
    };
}

async function mergeSingleton(db, table, column, sourceId, canonicalId, preferSource) {
    const sourceCount = await countValue(db, table, column, sourceId);
    if (!sourceCount) return { changes: 0, mode: 'absent' };
    if (sourceCount > 1) {
        throw new AdminIdentityRepairError(
            'identity_singleton_source_invalid',
            `${table}.${column} não é singleton para o cadastro fonte.`,
            409
        );
    }

    const canonicalCount = await countValue(db, table, column, canonicalId);
    if (canonicalCount > 1) {
        throw new AdminIdentityRepairError(
            'identity_singleton_canonical_invalid',
            `${table}.${column} não é singleton para o cadastro canônico.`,
            409
        );
    }

    if (!canonicalCount) {
        const result = await repointCollisionAware(
            db,
            table,
            column,
            sourceId,
            canonicalId
        );
        return { ...result, mode: 'singleton_moved' };
    }

    if (preferSource) {
        await db.run(
            `DELETE FROM ${quoteIdentifier(table)}
             WHERE ${quoteIdentifier(column)} = ?`,
            [canonicalId]
        );
        const result = await repointCollisionAware(
            db,
            table,
            column,
            sourceId,
            canonicalId
        );
        return {
            ...result,
            changes: Number(result?.changes || 0) + 1,
            mode: 'source_replaced_target',
        };
    }

    const result = await db.run(
        `DELETE FROM ${quoteIdentifier(table)}
         WHERE ${quoteIdentifier(column)} = ?`,
        [sourceId]
    );
    return { changes: Number(result?.changes || 0), mode: 'source_discarded' };
}

async function mergeAuxiliary(db, table, column, sourceId, canonicalId) {
    const sourceCount = await countValue(db, table, column, sourceId);
    if (!sourceCount) return { changes: 0, mode: 'absent' };
    const canonicalCount = await countValue(db, table, column, canonicalId);
    if (!canonicalCount) {
        const result = await repointCollisionAware(
            db,
            table,
            column,
            sourceId,
            canonicalId
        );
        return { ...result, mode: 'auxiliary_moved' };
    }
    const result = await db.run(
        `DELETE FROM ${quoteIdentifier(table)}
         WHERE ${quoteIdentifier(column)} = ?`,
        [sourceId]
    );
    return {
        changes: Number(result?.changes || 0),
        mode: 'duplicate_deleted',
    };
}

async function applyReference(db, reference, sourceId, canonicalId, preferSource) {
    const { table, column, strategy } = reference;
    if (EXECUTOR_PASSIVE_STRATEGIES.has(strategy)) {
        return { changes: 0, mode: 'passive' };
    }
    if (strategy === 'unknown') {
        throw new AdminIdentityRepairError(
            'identity_unknown_reference',
            `Referência sem estratégia: ${table}.${column}.`,
            409
        );
    }
    if (strategy === 'merge_singleton') {
        return mergeSingleton(
            db,
            table,
            column,
            sourceId,
            canonicalId,
            preferSource
        );
    }
    if (strategy === 'merge_or_delete_auxiliary') {
        return mergeAuxiliary(db, table, column, sourceId, canonicalId);
    }
    return repointCollisionAware(db, table, column, sourceId, canonicalId);
}

async function applyIdentityRepairPlan(db, plan) {
    if (!plan?.readyForExecutor) {
        throw new AdminIdentityRepairError(
            'identity_repair_not_ready',
            plan?.reason || 'O reparo não está pronto para execução.',
            409,
            { action: plan?.action || null }
        );
    }

    const preferSource = plan.action === 'transactional_canonical_migration'
        && plan.sourceId === plan.dataOwnerId;
    const journal = [];

    for (const reference of plan.sourceReferences.references || []) {
        if (EXECUTOR_PASSIVE_STRATEGIES.has(reference.strategy)) continue;
        const result = await applyReference(
            db,
            reference,
            plan.sourceId,
            plan.canonicalId,
            preferSource
        );
        journal.push({ ...reference, ...result });
    }

    if (preferSource) {
        await db.run('DELETE FROM jogadores WHERE id = ?', [plan.canonicalId]);
        const moved = await db.run(
            `UPDATE jogadores
             SET id = ?, canonical_player_id = ?, merged_into = NULL,
                 is_shadow = 0, identity_status = COALESCE(identity_status, 'active')
             WHERE id = ?`,
            [plan.canonicalId, plan.canonicalId, plan.sourceId]
        );
        if (Number(moved?.changes || 0) !== 1) {
            throw new AdminIdentityRepairError(
                'identity_source_promotion_failed',
                'Falha ao promover o cadastro fonte para o ID canônico.',
                409
            );
        }
    } else {
        const deleted = await db.run(
            'DELETE FROM jogadores WHERE id = ?',
            [plan.sourceId]
        );
        if (Number(deleted?.changes || 0) !== 1) {
            throw new AdminIdentityRepairError(
                'identity_source_delete_failed',
                'Falha ao remover o cadastro fonte depois da consolidação.',
                409
            );
        }
    }

    const canonicalCount = await countValue(
        db,
        'jogadores',
        'id',
        plan.canonicalId
    );
    const sourceCount = await countValue(
        db,
        'jogadores',
        'id',
        plan.sourceId
    );
    if (canonicalCount !== 1 || sourceCount !== 0) {
        throw new AdminIdentityRepairError(
            'identity_post_validation_failed',
            'A pós-validação da identidade falhou.',
            409,
            { canonicalCount, sourceCount }
        );
    }

    for (const reference of plan.sourceReferences.references || []) {
        if (reference.strategy === 'preserve_alias_value') continue;
        const remaining = await countValue(
            db,
            reference.table,
            reference.column,
            plan.sourceId
        );
        if (remaining !== 0) {
            throw new AdminIdentityRepairError(
                'identity_reference_remained',
                `Referência do cadastro fonte permaneceu em ${reference.table}.${reference.column}.`,
                409,
                { remaining }
            );
        }
    }

    const integrityRows = await db.all('PRAGMA integrity_check');
    const integrityFailures = integrityRows
        .flatMap((row) => Object.values(row))
        .filter((value) => String(value).toLowerCase() !== 'ok');
    if (integrityFailures.length) {
        throw new AdminIdentityRepairError(
            'identity_integrity_check_failed',
            'PRAGMA integrity_check falhou após a consolidação.',
            500,
            { failures: integrityFailures }
        );
    }

    return { journal };
}

async function simulateIdentityRepair(db, plan) {
    previewCounter += 1;
    const savepoint = `admin_identity_repair_preview_${previewCounter}`;
    await db.exec(`SAVEPOINT ${savepoint}`);
    try {
        const result = await applyIdentityRepairPlan(db, plan);
        await db.exec(`ROLLBACK TO ${savepoint}`);
        await db.exec(`RELEASE ${savepoint}`);
        return result;
    } catch (error) {
        await db.exec(`ROLLBACK TO ${savepoint}`).catch(() => null);
        await db.exec(`RELEASE ${savepoint}`).catch(() => null);
        throw error;
    }
}

function assertCanonicalTarget(target, canonicalId) {
    if (target?.kind === 'player' && target?.playerId === canonicalId) return;
    throw new AdminIdentityRepairError(
        'identity_target_mismatch',
        'O alvo da OP- precisa ser exatamente o cadastro canônico.',
        400,
        {
            targetPlayerId: target?.playerId || null,
            canonicalId,
        }
    );
}

function createIdentityRepairExecutors() {
    return {
        'player.identity.repair': {
            async preview({ db, action, target }) {
                const sourceId = String(action.payload?.sourcePlayerId || '').trim();
                const canonicalId = String(
                    action.payload?.canonicalPlayerId
                    || target?.playerId
                    || ''
                ).trim();
                assertCanonicalTarget(target, canonicalId);

                const plan = await buildLiveIdentityRepairPlan(
                    db,
                    sourceId,
                    canonicalId
                );
                if (!plan.readyForExecutor) {
                    throw new AdminIdentityRepairError(
                        'identity_repair_blocked',
                        plan.reason,
                        409,
                        {
                            action: plan.action,
                            source: plan.source,
                            canonical: plan.canonical,
                            unknownReferences: plan.sourceReferences.unknownReferences,
                        }
                    );
                }

                const simulation = await simulateIdentityRepair(db, plan);
                return {
                    summary: `Consolidar ${plan.source.name} em ${plan.canonical.name}`,
                    before: {
                        planFingerprint: plan.fingerprint,
                        sourceId: plan.sourceId,
                        canonicalId: plan.canonicalId,
                        source: plan.source,
                        canonical: plan.canonical,
                    },
                    after: {
                        action: plan.action,
                        reason: plan.reason,
                        referenceCount: plan.sourceReferences.references.length,
                        references: plan.sourceReferences.references,
                        simulationJournal: simulation.journal,
                    },
                    metadata: {
                        scope: 'identity-repair',
                        undoSafe: false,
                        recovery: 'restore_database_backup_or_forward_identity_repair',
                    },
                };
            },

            async apply({ db, action, target, before }) {
                const sourceId = String(action.payload?.sourcePlayerId || '').trim();
                const canonicalId = String(
                    action.payload?.canonicalPlayerId
                    || target?.playerId
                    || ''
                ).trim();
                assertCanonicalTarget(target, canonicalId);

                const currentPlan = await buildLiveIdentityRepairPlan(
                    db,
                    sourceId,
                    canonicalId
                );
                if (
                    !currentPlan.readyForExecutor
                    || currentPlan.fingerprint !== before?.planFingerprint
                ) {
                    throw new AdminIdentityRepairError(
                        'identity_repair_changed_after_preview',
                        'O plano de identidade mudou depois da prévia. Gere uma nova OP-.',
                        409,
                        {
                            expectedFingerprint: before?.planFingerprint || null,
                            currentFingerprint: currentPlan.fingerprint,
                            currentAction: currentPlan.action,
                            currentReason: currentPlan.reason,
                        }
                    );
                }

                const result = await applyIdentityRepairPlan(db, currentPlan);
                return {
                    summary: `Identidade consolidada em ${currentPlan.canonicalId}.`,
                    before,
                    after: {
                        canonicalId: currentPlan.canonicalId,
                        removedSourceId: currentPlan.sourceId,
                        journal: result.journal,
                    },
                    metadata: {
                        scope: 'identity-repair',
                        undoSafe: false,
                        recovery: 'restore_database_backup_or_forward_identity_repair',
                    },
                };
            },
        },
    };
}

module.exports = {
    ACTIVITY_SOURCES,
    AdminIdentityRepairError,
    REFERENCE_RULES,
    applyIdentityRepairPlan,
    buildLiveIdentityRepairPlan,
    createIdentityRepairExecutors,
    discoverReferences,
    fingerprint,
    inspectPlayer,
    simulateIdentityRepair,
};
