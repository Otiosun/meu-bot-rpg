'use strict';

const crypto = require('crypto');
const {
    FIXED_TRAIT_SLOTS,
    ensureAdminTraitSchema,
    isEmptyTraitValue,
    slugifyTraitKey,
} = require('./adminTraitService');

const MIGRATION_ID = 'traits-v2-legacy-import-20260723';
const QUESTION_REPAIRS = Object.freeze({
    'Anal?tico': 'Analítico',
    'Prod?gio': 'Prodígio',
    'Of?cio': 'Ofício',
    'D?vida': 'Dívida',
    'B?ssola': 'Bússola',
    'N?o': 'Não',
    'Mem?rias': 'Memórias',
    'amaldi?oado': 'amaldiçoado',
    'Amaldi?oado': 'Amaldiçoado',
});
const TITLE_OVERRIDES = Object.freeze({
    divida_de_vida: 'Dívida de Vida',
    olhar_analitico: 'Olhar Analítico',
    prodigio_de_mana: 'Prodígio de Mana',
    filho_de_oficio: 'Filho de Ofício',
});

function parseJson(value, fallback) {
    if (!value) return fallback;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function weirdScore(value) {
    return ['Ã', 'Â', 'â€', 'ðŸ', '�'].reduce((total, marker) => total + String(value || '').split(marker).length - 1, 0);
}

function repairLegacyText(value) {
    if (typeof value !== 'string' || !value) return value;
    let repaired = value;
    for (const [before, after] of Object.entries(QUESTION_REPAIRS)) repaired = repaired.split(before).join(after);
    const candidates = [repaired];
    try {
        candidates.push(Buffer.from(repaired, 'latin1').toString('utf8'));
    } catch {}
    candidates.sort((left, right) => {
        const leftScore = [weirdScore(left), (left.match(/\?/g) || []).length];
        const rightScore = [weirdScore(right), (right.match(/\?/g) || []).length];
        return leftScore[0] - rightScore[0] || leftScore[1] - rightScore[1];
    });
    return candidates[0];
}

function stableTraitId(slotKey, canonicalKey) {
    return `TR-LG-${crypto.createHash('sha256').update(`${slotKey}|${canonicalKey}`).digest('hex').slice(0, 12).toUpperCase()}`;
}

function canonicalTitle(key, variants) {
    if (TITLE_OVERRIDES[key]) return TITLE_OVERRIDES[key];
    const counts = new Map();
    for (const raw of variants) {
        const value = repairLegacyText(String(raw || '').trim());
        if (!value) continue;
        counts.set(value, (counts.get(value) || 0) + 1);
    }
    return [...counts.keys()].sort((left, right) => {
        return (counts.get(right) - counts.get(left))
            || ((left.match(/\?/g) || []).length - (right.match(/\?/g) || []).length)
            || (weirdScore(left) - weirdScore(right))
            || left.localeCompare(right, 'pt-BR');
    })[0] || key.replace(/_/g, ' ');
}

function mergeMetadata(raw, additions) {
    const current = parseJson(raw, {});
    return JSON.stringify({ ...(current && typeof current === 'object' && !Array.isArray(current) ? current : {}), ...additions });
}

async function ensureMigrationSchema(db) {
    await ensureAdminTraitSchema(db);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_trait_migration_runs (
            migration_id TEXT PRIMARY KEY,
            source_sha256 TEXT NOT NULL,
            report_json TEXT NOT NULL,
            applied_at TEXT NOT NULL
        )
    `);
}

async function upsertTemplate(db, input, report) {
    const existing = await db.get(
        'SELECT * FROM clover_trait_templates WHERE slot_key = ? AND canonical_key = ?',
        [input.slotKey, input.canonicalKey]
    );
    const timestamp = new Date().toISOString();
    if (existing) {
        const description = existing.description || input.description || null;
        const metadata = mergeMetadata(existing.metadata_json, input.metadata);
        if (description !== existing.description || metadata !== existing.metadata_json) {
            await db.run(
                'UPDATE clover_trait_templates SET description = ?, metadata_json = ?, updated_at = ? WHERE id = ?',
                [description, metadata, timestamp, existing.id]
            );
            report.templatesUpdated += 1;
        }
        return existing.id;
    }
    const id = stableTraitId(input.slotKey, input.canonicalKey);
    await db.run(
        `INSERT INTO clover_trait_templates
         (id, name, slot_key, description, effect_text, restrictions_text, status, version,
          metadata_json, operation_code, created_by, updated_by, created_at, updated_at,
          canonical_key, trait_kind, source)
         VALUES (?, ?, ?, ?, NULL, NULL, 'active', 1, ?, NULL, 'legacy-migration',
                 'legacy-migration', ?, ?, ?, ?, ?)`,
        [
            id, input.name, input.slotKey, input.description || null, JSON.stringify(input.metadata),
            timestamp, timestamp, input.canonicalKey, input.traitKind, input.source,
        ]
    );
    report.templatesCreated += 1;
    report.templatesBySlot[input.slotKey] = (report.templatesBySlot[input.slotKey] || 0) + 1;
    return id;
}

async function insertAssignment(db, input, report) {
    if (await db.get('SELECT id FROM clover_player_traits WHERE assignment_key = ?', [input.assignmentKey])) {
        report.assignmentsSkippedExisting += 1;
        return;
    }
    if (FIXED_TRAIT_SLOTS.includes(input.slotKey)) {
        const active = await db.get(
            'SELECT id, trait_id FROM clover_player_traits WHERE player_id = ? AND slot_key = ? AND active = 1',
            [input.playerId, input.slotKey]
        );
        if (active) {
            if (active.trait_id === input.traitId) report.assignmentsSkippedExisting += 1;
            else report.assignmentConflicts.push({ slotKey: input.slotKey, existingTraitId: active.trait_id, legacyTraitId: input.traitId });
            return;
        }
    }
    await db.run(
        `INSERT INTO clover_player_traits
         (player_id, trait_id, slot_key, value_text, active, operation_code, assigned_by,
          removed_by, metadata_json, assigned_at, removed_at, position, source, legacy_ref, assignment_key)
         VALUES (?, ?, ?, ?, 1, NULL, 'legacy-migration', NULL, ?, ?, NULL, ?, ?, ?, ?)`,
        [
            input.playerId, input.traitId, input.slotKey, input.valueText, JSON.stringify(input.metadata),
            new Date().toISOString(), input.position || 0, input.source, input.legacyRef, input.assignmentKey,
        ]
    );
    report.assignmentsCreated += 1;
    report.assignmentsBySlot[input.slotKey] = (report.assignmentsBySlot[input.slotKey] || 0) + 1;
}

async function repairContentRows(db, report) {
    const exists = await db.get("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='clover_player_content'");
    if (!exists) return;
    const rows = await db.all('SELECT * FROM clover_player_content ORDER BY id');
    for (const row of rows) {
        const originals = {};
        const changes = {};
        for (const column of ['title', 'body', 'raw_source_text']) {
            const repaired = repairLegacyText(row[column]);
            if (typeof row[column] === 'string' && repaired !== row[column]) {
                originals[column] = row[column];
                changes[column] = repaired;
            }
        }
        if (!Object.keys(changes).length) continue;
        const metadata = parseJson(row.metadata_json, {});
        metadata.legacyTextRepair = { migrationId: MIGRATION_ID, original: originals };
        await db.run(
            `UPDATE clover_player_content
             SET title = ?, body = ?, raw_source_text = ?, metadata_json = ?, updated_at = ?
             WHERE id = ?`,
            [
                changes.title ?? row.title,
                changes.body ?? row.body,
                changes.raw_source_text ?? row.raw_source_text,
                JSON.stringify(metadata),
                new Date().toISOString(),
                row.id,
            ]
        );
        report.contentRowsRepaired += 1;
    }
}

async function insertHook(db, playerId, entry, index, report) {
    const title = repairLegacyText(String(entry.title || '').trim());
    if (!title) return;
    const key = slugifyTraitKey(title);
    const body = repairLegacyText(String(entry.description || '').trim()) || null;
    const existing = await db.get(
        `SELECT * FROM clover_player_content
         WHERE player_id = ? AND content_type = 'narrative_hook' AND content_key = ? AND active = 1
         ORDER BY version DESC LIMIT 1`,
        [playerId, key]
    );
    if (existing) {
        if (!existing.body && body) {
            await db.run(
                'UPDATE clover_player_content SET body = ?, raw_source_text = ?, updated_at = ? WHERE id = ?',
                [body, body, new Date().toISOString(), existing.id]
            );
            report.hooksUpdated += 1;
        } else report.hooksSkippedExisting += 1;
        return;
    }
    const timestamp = new Date().toISOString();
    await db.run(
        `INSERT INTO clover_player_content
         (player_id, content_type, content_key, title, body, raw_source_text,
          mechanical_status, review_status, linked_content_id, version, active,
          source, created_by, created_at, updated_at, metadata_json)
         VALUES (?, 'narrative_hook', ?, ?, ?, ?, 'not_applicable', 'approved', NULL, 1, 1,
                 'legacy_historias_extras', 'legacy-migration', ?, ?, ?)`,
        [
            playerId, key, title, body, body, timestamp, timestamp,
            JSON.stringify({ legacyMigration: { migrationId: MIGRATION_ID, index } }),
        ]
    );
    report.hooksCreated += 1;
}

async function countIfPresent(db, table, where = '') {
    const exists = await db.get("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=?", [table]);
    if (!exists) return 0;
    const row = await db.get(`SELECT COUNT(*) AS total FROM ${table} ${where}`);
    return Number(row?.total || 0);
}

async function runAdminTraitLegacyMigration(db, options = {}) {
    const report = {
        migrationId: MIGRATION_ID,
        sourceSha256: String(options.sourceSha256 || 'unknown'),
        templatesCreated: 0,
        templatesUpdated: 0,
        templatesBySlot: {},
        assignmentsCreated: 0,
        assignmentsSkippedExisting: 0,
        assignmentsBySlot: {},
        assignmentConflicts: [],
        hooksCreated: 0,
        hooksUpdated: 0,
        hooksSkippedExisting: 0,
        contentRowsRepaired: 0,
        legacyRowsScanned: 0,
        legacyExtraEntriesScanned: 0,
        legacyExtraTypeCounts: {},
        warnings: [],
    };

    await db.exec('BEGIN IMMEDIATE');
    try {
        await ensureMigrationSchema(db);
        await repairContentRows(db, report);
        const players = await db.all(
            `SELECT id, personagem_nome,
                    aptidao_comum, aptidao_comum_key,
                    marca_comum, marca_comum_key,
                    aptidao_rara, aptidao_rara_key,
                    marca_rara, marca_rara_key,
                    anomalia, anomalia_key,
                    historias_extras
             FROM jogadores ORDER BY id`
        );
        report.legacyRowsScanned = players.length;

        const variants = new Map();
        const fixedRows = [];
        for (const player of players) {
            for (const slotKey of FIXED_TRAIT_SLOTS) {
                const value = player[slotKey];
                if (isEmptyTraitValue(value)) continue;
                const canonicalKey = String(player[`${slotKey}_key`] || '').trim() || slugifyTraitKey(value);
                const mapKey = `${slotKey}\u0000${canonicalKey}`;
                if (!variants.has(mapKey)) variants.set(mapKey, { slotKey, canonicalKey, values: [] });
                variants.get(mapKey).values.push(String(value).trim());
                fixedRows.push({ player, slotKey, canonicalKey, originalValue: String(value).trim() });
            }
        }

        const templates = new Map();
        for (const entry of [...variants.values()].sort((a, b) => `${a.slotKey}:${a.canonicalKey}`.localeCompare(`${b.slotKey}:${b.canonicalKey}`))) {
            const name = canonicalTitle(entry.canonicalKey, entry.values);
            const traitId = await upsertTemplate(db, {
                slotKey: entry.slotKey,
                canonicalKey: entry.canonicalKey,
                name,
                description: null,
                traitKind: 'system',
                source: 'legacy_fixed_slot',
                metadata: {
                    canonicalKey: entry.canonicalKey,
                    descriptionStatus: 'missing_in_legacy_database',
                    legacyMigration: {
                        migrationId: MIGRATION_ID,
                        source: `jogadores.${entry.slotKey}`,
                        assignmentCount: entry.values.length,
                        titleVariants: [...new Set(entry.values)].sort(),
                    },
                },
            }, report);
            templates.set(`${entry.slotKey}\u0000${entry.canonicalKey}`, { traitId, name });
        }

        for (const row of fixedRows) {
            const template = templates.get(`${row.slotKey}\u0000${row.canonicalKey}`);
            await insertAssignment(db, {
                playerId: row.player.id,
                traitId: template.traitId,
                slotKey: row.slotKey,
                valueText: template.name,
                position: 0,
                source: 'legacy_fixed_slot',
                legacyRef: `jogadores.${row.slotKey}`,
                assignmentKey: `legacy-fixed:${row.player.id}:${row.slotKey}`,
                metadata: { legacyMigration: { migrationId: MIGRATION_ID, originalValue: row.originalValue } },
            }, report);
        }

        const positions = new Map();
        for (const player of players) {
            const extras = parseJson(player.historias_extras, []);
            if (!Array.isArray(extras)) {
                report.warnings.push({ type: 'invalid_historias_extras' });
                continue;
            }
            for (let index = 0; index < extras.length; index += 1) {
                const entry = extras[index];
                if (!entry || typeof entry !== 'object') continue;
                const rawType = String(entry.type || entry.tipo || '').trim().toLowerCase();
                report.legacyExtraEntriesScanned += 1;
                report.legacyExtraTypeCounts[rawType || 'blank'] = (report.legacyExtraTypeCounts[rawType || 'blank'] || 0) + 1;
                if (rawType === 'gn') {
                    await insertHook(db, player.id, entry, index, report);
                    continue;
                }
                let slotKey;
                let traitKind;
                if (['traço', 'traco', 'traço novo', 'traco_novo', 'traco novo'].includes(rawType)) {
                    slotKey = 'extra_trait';
                    traitKind = ['traço', 'traco'].includes(rawType) ? 'system' : 'custom';
                } else if (['anomalia', 'anomaly'].includes(rawType)) {
                    slotKey = 'extra_anomaly';
                    traitKind = 'custom';
                } else {
                    report.warnings.push({ type: 'unsupported_extra_type', rawType });
                    continue;
                }
                const title = repairLegacyText(String(entry.title || '').trim());
                if (!title) {
                    report.warnings.push({ type: 'extra_entry_without_title', index });
                    continue;
                }
                const canonicalKey = slugifyTraitKey(title);
                const description = repairLegacyText(String(entry.description || '').trim()) || null;
                const name = canonicalTitle(canonicalKey, [title]);
                const traitId = await upsertTemplate(db, {
                    slotKey,
                    canonicalKey,
                    name,
                    description,
                    traitKind,
                    source: 'legacy_historias_extras',
                    metadata: {
                        canonicalKey,
                        descriptionStatus: description ? 'available' : 'missing_in_legacy_database',
                        legacyMigration: { migrationId: MIGRATION_ID, source: 'jogadores.historias_extras', legacyType: rawType },
                    },
                }, report);
                const positionKey = `${player.id}\u0000${slotKey}`;
                const position = (positions.get(positionKey) || 0) + 1;
                positions.set(positionKey, position);
                await insertAssignment(db, {
                    playerId: player.id,
                    traitId,
                    slotKey,
                    valueText: name,
                    position,
                    source: 'legacy_historias_extras',
                    legacyRef: `jogadores.historias_extras[${index}]`,
                    assignmentKey: `legacy-extra:${player.id}:${index}:${slotKey}:${canonicalKey}`,
                    metadata: { legacyMigration: { migrationId: MIGRATION_ID, index, legacyType: rawType } },
                }, report);
            }
        }

        report.integrityCheck = (await db.get('PRAGMA integrity_check')).integrity_check;
        report.templatesTotal = await countIfPresent(db, 'clover_trait_templates');
        report.assignmentsTotal = await countIfPresent(db, 'clover_player_traits', 'WHERE active = 1');
        report.contentTotal = await countIfPresent(db, 'clover_player_content', 'WHERE active = 1');
        report.bonusesTotal = await countIfPresent(db, 'clover_character_bonuses', "WHERE status = 'ativo'");
        report.attemptsTotal = await countIfPresent(db, 'clover_trait_attempts');
        report.completedAt = new Date().toISOString();
        await db.run(
            `INSERT INTO clover_trait_migration_runs (migration_id, source_sha256, report_json, applied_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(migration_id) DO UPDATE SET
                 source_sha256 = excluded.source_sha256,
                 report_json = excluded.report_json,
                 applied_at = excluded.applied_at`,
            [MIGRATION_ID, report.sourceSha256, JSON.stringify(report), report.completedAt]
        );
        await db.exec('COMMIT');
        return report;
    } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
    }
}

module.exports = {
    MIGRATION_ID,
    canonicalTitle,
    repairLegacyText,
    runAdminTraitLegacyMigration,
    stableTraitId,
};
