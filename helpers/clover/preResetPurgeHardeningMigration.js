'use strict';

const PRE_RESET_PURGE_HARDENING_VERSION = 36;
const PRE_RESET_PURGE_HARDENING_KEY = '0036_prereset_purge_hardening';

const PRE_RESET_PURGE_HARDENING_OBJECTS = Object.freeze([
    Object.freeze({
        type: 'trigger',
        name: 'trg_prereset_purge_blocks_character_restore',
        table: 'jogadores',
        sql: `
CREATE TRIGGER trg_prereset_purge_blocks_character_restore
BEFORE UPDATE OF
    personagem_nome,
    personagem_idade,
    personagem_genero,
    personagem_aparencia,
    personagem_aparencia_normalizada,
    personagem_aparencia_status,
    personagem_aparencia_motivo,
    personagem_aparencia_image_path,
    personagem_aparencia_image_message_id,
    personagem_aparencia_approved_by,
    personagem_aparencia_approved_at,
    numero_roll_escolhido,
    reino,
    classe,
    raca,
    grimorio,
    familia,
    familia_key,
    magia,
    magia_key,
    aptidao_comum,
    aptidao_comum_key,
    marca_comum,
    marca_comum_key,
    aptidao_rara,
    aptidao_rara_key,
    marca_rara,
    marca_rara_key,
    anomalia,
    anomalia_key
ON jogadores
WHEN EXISTS (
    SELECT 1 FROM clover_prereset_purge_tombstones t WHERE t.player_id = OLD.id
)
AND (
    COALESCE(NEW.personagem_nome, '') <> '-'
    OR NEW.personagem_idade IS NOT NULL
    OR COALESCE(NEW.personagem_genero, '') <> '-'
    OR COALESCE(NEW.personagem_aparencia, '') <> '-'
    OR NEW.personagem_aparencia_normalizada IS NOT NULL
    OR COALESCE(NEW.personagem_aparencia_status, '') <> 'pending'
    OR COALESCE(NEW.personagem_aparencia_motivo, '') <> 'purge_pre_reset'
    OR NEW.personagem_aparencia_image_path IS NOT NULL
    OR NEW.personagem_aparencia_image_message_id IS NOT NULL
    OR NEW.personagem_aparencia_approved_by IS NOT NULL
    OR NEW.personagem_aparencia_approved_at IS NOT NULL
    OR NEW.numero_roll_escolhido IS NOT NULL
    OR COALESCE(NEW.reino, '') <> '-'
    OR COALESCE(NEW.classe, '') <> '-'
    OR COALESCE(NEW.raca, '') <> '-'
    OR COALESCE(NEW.grimorio, '') <> '-'
    OR COALESCE(NEW.familia, '') <> '-'
    OR NEW.familia_key IS NOT NULL
    OR COALESCE(NEW.magia, '') <> '-'
    OR NEW.magia_key IS NOT NULL
    OR COALESCE(NEW.aptidao_comum, '') <> '-'
    OR NEW.aptidao_comum_key IS NOT NULL
    OR COALESCE(NEW.marca_comum, '') <> '-'
    OR NEW.marca_comum_key IS NOT NULL
    OR COALESCE(NEW.aptidao_rara, '') <> '-'
    OR NEW.aptidao_rara_key IS NOT NULL
    OR COALESCE(NEW.marca_rara, '') <> '-'
    OR NEW.marca_rara_key IS NOT NULL
    OR COALESCE(NEW.anomalia, '') <> '-'
    OR NEW.anomalia_key IS NOT NULL
)
BEGIN
    SELECT RAISE(ABORT, 'prereset_purged_character_restore_forbidden');
END
`,
    }),
    Object.freeze({
        type: 'trigger',
        name: 'trg_prereset_purge_blocks_transition_insert',
        table: 'clover_prereset_transition_decisions',
        sql: `
CREATE TRIGGER trg_prereset_purge_blocks_transition_insert
BEFORE INSERT ON clover_prereset_transition_decisions
WHEN EXISTS (
    SELECT 1 FROM clover_prereset_purge_tombstones t WHERE t.player_id = NEW.player_id
)
BEGIN
    SELECT RAISE(ABORT, 'prereset_purged_transition_forbidden');
END
`,
    }),
    Object.freeze({
        type: 'trigger',
        name: 'trg_prereset_purge_blocks_transition_update',
        table: 'clover_prereset_transition_decisions',
        sql: `
CREATE TRIGGER trg_prereset_purge_blocks_transition_update
BEFORE UPDATE ON clover_prereset_transition_decisions
WHEN EXISTS (
    SELECT 1
    FROM clover_prereset_purge_tombstones t
    WHERE t.player_id = OLD.player_id OR t.player_id = NEW.player_id
)
BEGIN
    SELECT RAISE(ABORT, 'prereset_purged_transition_forbidden');
END
`,
    }),
    Object.freeze({
        type: 'trigger',
        name: 'trg_prereset_purge_blocks_roll_update',
        table: 'player_rolls',
        sql: `
CREATE TRIGGER trg_prereset_purge_blocks_roll_update
BEFORE UPDATE ON player_rolls
WHEN EXISTS (
    SELECT 1
    FROM clover_prereset_purge_tombstones t
    WHERE t.player_id = OLD.player_id OR t.player_id = NEW.player_id
)
BEGIN
    SELECT RAISE(ABORT, 'prereset_purged_roll_forbidden');
END
`,
    }),
]);

function normalizeSql(sql) {
    return String(sql || '')
        .replace(/\bIF\s+NOT\s+EXISTS\b/gi, '')
        .replace(/"([A-Za-z_][A-Za-z0-9_]*)"/g, '$1')
        .replace(/\s+/g, ' ')
        .replace(/\s*([(),;])\s*/g, '$1')
        .trim()
        .toLowerCase();
}

async function inspectPreResetPurgeHardeningSchemaState(db) {
    const names = PRE_RESET_PURGE_HARDENING_OBJECTS.map((entry) => entry.name);
    const placeholders = names.map(() => '?').join(', ');
    const rows = await db.all(
        `SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name IN (${placeholders})`,
        names
    );
    const byName = new Map(rows.map((row) => [row.name, row]));
    const objects = PRE_RESET_PURGE_HARDENING_OBJECTS.map((expected) => {
        const observed = byName.get(expected.name) || null;
        const exact = Boolean(observed)
            && observed.type === expected.type
            && observed.tbl_name === expected.table
            && normalizeSql(observed.sql) === normalizeSql(expected.sql);
        return Object.freeze({ name: expected.name, exists: Boolean(observed), exact });
    });
    if (objects.every((entry) => !entry.exists)) return Object.freeze({ kind: 'absent', objects });
    if (objects.every((entry) => entry.exact)) return Object.freeze({ kind: 'exact', objects });
    return Object.freeze({ kind: 'partial_or_divergent', objects });
}

async function cleanupExistingPurgedFutureCharacters(db) {
    await db.run(
        `DELETE FROM clover_prereset_characters
         WHERE player_id IN (
             SELECT player_id FROM clover_prereset_purge_tombstones
         )`
    );
}

async function createPreResetPurgeHardeningObjects(db) {
    for (const object of PRE_RESET_PURGE_HARDENING_OBJECTS) await db.exec(object.sql);
}

const PRE_RESET_PURGE_HARDENING_MIGRATION = Object.freeze({
    version: PRE_RESET_PURGE_HARDENING_VERSION,
    key: PRE_RESET_PURGE_HARDENING_KEY,
    description: 'Endurece purge definitivo contra restauracao de personagem, transicao ou roll e remove future state residual.',
    checksumMaterial: Object.freeze({
        objects: PRE_RESET_PURGE_HARDENING_OBJECTS,
        cleanup: 'delete clover_prereset_characters for existing purge tombstones',
        acceptedLegacySchemaLineage: ['absent', 'exact'],
        revision: 'prereset-purge-hardening-v1',
    }),
    async up(db) {
        await cleanupExistingPurgedFutureCharacters(db);
        const before = await inspectPreResetPurgeHardeningSchemaState(db);
        if (before.kind === 'exact') return;
        if (before.kind !== 'absent') {
            const error = new Error('Schema de hardening do purge pre-reset parcial/divergente exige reconciliacao explicita.');
            error.code = 'prereset_purge_hardening_schema_reconciliation_required';
            error.state = before;
            throw error;
        }
        await createPreResetPurgeHardeningObjects(db);
        const after = await inspectPreResetPurgeHardeningSchemaState(db);
        if (after.kind !== 'exact') {
            const error = new Error('Migration 0036 nao produziu o schema canonico de hardening do purge.');
            error.code = 'prereset_purge_hardening_schema_not_exact';
            error.state = after;
            throw error;
        }
    },
});

module.exports = {
    PRE_RESET_PURGE_HARDENING_KEY,
    PRE_RESET_PURGE_HARDENING_MIGRATION,
    PRE_RESET_PURGE_HARDENING_OBJECTS,
    PRE_RESET_PURGE_HARDENING_VERSION,
    cleanupExistingPurgedFutureCharacters,
    createPreResetPurgeHardeningObjects,
    inspectPreResetPurgeHardeningSchemaState,
    normalizeSql,
};
