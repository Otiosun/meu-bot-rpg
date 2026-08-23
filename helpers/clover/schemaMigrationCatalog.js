'use strict';

const {
    CORE_MIGRATIONS,
    addColumnIfMissing,
} = require('./schemaMigrationService');

const MARKET_REQUEST_VERSION = 4;
const MARKET_REQUEST_KEY = '0004_market_request_columns';
const QUICK_EVALUATION_VERSION = 5;
const QUICK_EVALUATION_KEY = '0005_quick_evaluation_columns';
const PLAYER_ROLLS_VERSION = 6;
const PLAYER_ROLLS_KEY = '0006_player_roll_columns';
const ITEM_TEMPLATES_VERSION = 7;
const ITEM_TEMPLATES_KEY = '0007_item_template_columns';
const INVENTORY_ITEMS_VERSION = 8;
const INVENTORY_ITEMS_KEY = '0008_inventory_item_columns';
const ADMIN_SERVICE_VERSION = 9;
const ADMIN_SERVICE_KEY = '0009_admin_service_columns';
const PLAYER_PROFILE_VERSION = 10;
const PLAYER_PROFILE_KEY = '0010_player_profile_columns';
const CHARACTER_IDENTITY_VERSION = 11;
const CHARACTER_IDENTITY_KEY = '0011_character_identity_columns';
const APPEARANCE_MODERATION_VERSION = 12;
const APPEARANCE_MODERATION_KEY = '0012_appearance_moderation_columns';
const SITE_PROFILE_IMAGE_VERSION = 13;
const SITE_PROFILE_IMAGE_KEY = '0013_site_profile_image_columns';
const CHARACTER_TRAITS_VERSION = 14;
const CHARACTER_TRAITS_KEY = '0014_character_trait_columns';
const ROLL_ATTEMPT_STATE_VERSION = 15;
const ROLL_ATTEMPT_STATE_KEY = '0015_roll_attempt_state_columns';
const STORY_STATE_VERSION = 16;
const STORY_STATE_KEY = '0016_story_state_columns';
const GAME_STATE_VERSION = 17;
const GAME_STATE_KEY = '0017_game_state_columns';
const PLAYER_PATENT_VERSION = 18;
const PLAYER_PATENT_KEY = '0018_player_patent_column';
const SQUAD_COLUMNS_VERSION = 19;
const SQUAD_COLUMNS_KEY = '0019_squad_columns';
const RAID_V1_BRIDGE_VERSION = 20;
const RAID_V1_BRIDGE_KEY = '0020_raid_v1_bridge';
const RAID_V2_COLUMNS_VERSION = 21;
const RAID_V2_COLUMNS_KEY = '0021_raid_v2_columns';
const RAID_PARTICIPANT_FINALIZATION_VERSION = 22;
const RAID_PARTICIPANT_FINALIZATION_KEY = '0022_raid_participant_finalization';
const RAID_REWARDS_V2_VERSION = 23;
const RAID_REWARDS_V2_KEY = '0023_raid_rewards_v2';
const RAID_MONTHLY_PROGRESS_VERSION = 24;
const RAID_MONTHLY_PROGRESS_KEY = '0024_raid_monthly_progress';
const RAID_SUPPORT_TABLES_VERSION = 25;
const RAID_SUPPORT_TABLES_KEY = '0025_raid_support_tables';
const RAID_IDEMPOTENCY_REQUESTS_VERSION = 26;
const RAID_IDEMPOTENCY_REQUESTS_KEY = '0026_raid_idempotency_requests';
const RAID_REWARD_PROPOSAL_HISTORY_VERSION = 27;
const RAID_REWARD_PROPOSAL_HISTORY_KEY = '0027_raid_reward_proposal_history';
const RAID_REWARD_PROPOSAL_IDEMPOTENCY_VERSION = 28;
const RAID_REWARD_PROPOSAL_IDEMPOTENCY_KEY = '0028_raid_reward_proposal_idempotency';
const PRERESET_CHARACTER_LAUNCH_VERSION = 29;
const PRERESET_CHARACTER_LAUNCH_KEY = '0029_prereset_character_launch_foundation';
const MARKET_REQUEST_TARGETS = Object.freeze([
    Object.freeze({ table: 'clover_market_listings', column: 'idempotency_key', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_weekly_npc_requests', column: 'required_quality', definition: "TEXT NOT NULL DEFAULT 'qualquer'" }),
    Object.freeze({ table: 'clover_weekly_npc_requests', column: 'required_condition', definition: "TEXT NOT NULL DEFAULT 'qualquer'" }),
]);
const QUICK_EVALUATION_TARGETS = Object.freeze([
    Object.freeze({ table: 'clover_quick_evaluations', column: 'quoted_message_key', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_quick_evaluations', column: 'scene_sent_at', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_quick_evaluations', column: 'scene_source', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_quick_evaluations', column: 'evaluated_at', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_quick_evaluations', column: 'salary_eligible', definition: 'INTEGER DEFAULT NULL' }),
    Object.freeze({ table: 'clover_quick_evaluations', column: 'salary_service_type', definition: 'TEXT DEFAULT NULL' }),
]);

const PLAYER_ROLLS_TARGETS = Object.freeze([
    Object.freeze({ table: 'player_rolls', column: 'kingdom', definition: "TEXT DEFAULT '-'" }),
    Object.freeze({ table: 'player_rolls', column: 'grimoire_rank', definition: "TEXT DEFAULT '-'" }),
    Object.freeze({ table: 'player_rolls', column: 'grimoire_symbol', definition: "TEXT DEFAULT '-'" }),
    Object.freeze({ table: 'player_rolls', column: 'magic_scope', definition: "TEXT DEFAULT '-'" }),
    Object.freeze({ table: 'player_rolls', column: 'roll_version', definition: "TEXT DEFAULT 'legacy'" }),
    Object.freeze({ table: 'player_rolls', column: 'kingdom_key', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'player_rolls', column: 'social_class_key', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'player_rolls', column: 'race_key', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'player_rolls', column: 'grimoire_key', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'player_rolls', column: 'magic_rarity_key', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'player_rolls', column: 'roll_payload', definition: "TEXT DEFAULT '{}'" }),
]);

const ITEM_TEMPLATES_TARGETS = Object.freeze([
    Object.freeze({ table: 'clover_item_templates', column: 'is_custom', definition: 'INTEGER NOT NULL DEFAULT 0' }),
    Object.freeze({ table: 'clover_item_templates', column: 'requestable', definition: 'INTEGER NOT NULL DEFAULT 0' }),
    Object.freeze({ table: 'clover_item_templates', column: 'marketable', definition: 'INTEGER NOT NULL DEFAULT 1' }),
    Object.freeze({ table: 'clover_item_templates', column: 'duplicable', definition: 'INTEGER NOT NULL DEFAULT 1' }),
    Object.freeze({ table: 'clover_item_templates', column: 'created_by', definition: "TEXT DEFAULT 'system'" }),
    Object.freeze({ table: 'clover_item_templates', column: 'updated_by', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_item_templates', column: 'archived_at', definition: 'TEXT DEFAULT NULL' }),
]);

const INVENTORY_ITEMS_TARGETS = Object.freeze([
    Object.freeze({ table: 'clover_inventory_items', column: 'template_key', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_inventory_items', column: 'catalog_version', definition: 'INTEGER DEFAULT 1' }),
    Object.freeze({ table: 'clover_inventory_items', column: 'category', definition: "TEXT DEFAULT 'material'" }),
    Object.freeze({ table: 'clover_inventory_items', column: 'origin', definition: "TEXT DEFAULT 'Clover'" }),
    Object.freeze({ table: 'clover_inventory_items', column: 'status', definition: "TEXT DEFAULT 'disponivel'" }),
    Object.freeze({ table: 'clover_inventory_items', column: 'quality', definition: "TEXT DEFAULT 'comum'" }),
    Object.freeze({ table: 'clover_inventory_items', column: 'base_price', definition: 'INTEGER DEFAULT 0' }),
    Object.freeze({ table: 'clover_inventory_items', column: 'reference_price', definition: 'INTEGER DEFAULT 0' }),
    Object.freeze({ table: 'clover_inventory_items', column: 'durability_current', definition: 'INTEGER DEFAULT NULL' }),
    Object.freeze({ table: 'clover_inventory_items', column: 'durability_max', definition: 'INTEGER DEFAULT NULL' }),
    Object.freeze({ table: 'clover_inventory_items', column: 'bound', definition: 'INTEGER DEFAULT 0' }),
    Object.freeze({ table: 'clover_inventory_items', column: 'transferable', definition: 'INTEGER DEFAULT 1' }),
    Object.freeze({ table: 'clover_inventory_items', column: 'equipped_slot', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_inventory_items', column: 'expires_at', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_inventory_items', column: 'updated_at', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_inventory_items', column: 'properties_json', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_inventory_items', column: 'effects_json', definition: 'TEXT DEFAULT NULL' }),
]);

const ADMIN_SERVICE_TARGETS = Object.freeze([
    Object.freeze({ table: 'clover_admin_service_entries', column: 'target_player_id', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_admin_service_entries', column: 'evaluation_id', definition: 'INTEGER DEFAULT NULL' }),
    Object.freeze({ table: 'clover_admin_service_entries', column: 'paid_points', definition: 'INTEGER NOT NULL DEFAULT 0' }),
    Object.freeze({ table: 'clover_admin_service_entries', column: 'status', definition: "TEXT NOT NULL DEFAULT 'pending'" }),
    Object.freeze({ table: 'clover_admin_service_entries', column: 'service_week_key', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_admin_service_entries', column: 'scene_week_key', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_admin_service_entries', column: 'scene_sent_at', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_admin_service_entries', column: 'evaluated_at', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_admin_service_entries', column: 'created_by', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_admin_service_entries', column: 'voided_at', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_admin_service_entries', column: 'voided_by', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_admin_service_entries', column: 'reason', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_admin_service_entries', column: 'metadata_json', definition: 'TEXT DEFAULT NULL' }),
]);

const PLAYER_PROFILE_TARGETS = Object.freeze([
    Object.freeze({ table: 'jogadores', column: 'display_name', definition: "TEXT DEFAULT '-'" }),
    Object.freeze({ table: 'jogadores', column: 'nome_real', definition: "TEXT DEFAULT '-'" }),
    Object.freeze({ table: 'jogadores', column: 'idade_real', definition: 'INTEGER DEFAULT NULL' }),
    Object.freeze({ table: 'jogadores', column: 'gosta_de_fazer', definition: "TEXT DEFAULT '-'" }),
    Object.freeze({ table: 'jogadores', column: 'disponibilidade_detalhada', definition: "TEXT DEFAULT '-'" }),
]);

const CHARACTER_IDENTITY_TARGETS = Object.freeze([
    Object.freeze({ table: 'jogadores', column: 'personagem_nome', definition: "TEXT DEFAULT '-'" }),
    Object.freeze({ table: 'jogadores', column: 'personagem_idade', definition: 'INTEGER DEFAULT NULL' }),
    Object.freeze({ table: 'jogadores', column: 'personagem_genero', definition: "TEXT DEFAULT '-'" }),
    Object.freeze({ table: 'jogadores', column: 'numero_roll_escolhido', definition: 'INTEGER DEFAULT NULL' }),
    Object.freeze({ table: 'jogadores', column: 'ficha_status', definition: "TEXT DEFAULT 'incompleta'" }),
    Object.freeze({ table: 'jogadores', column: 'ultima_recepcao_em', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'jogadores', column: 'familia_key', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'jogadores', column: 'magia_key', definition: 'TEXT DEFAULT NULL' }),
]);
const APPEARANCE_MODERATION_TARGETS = Object.freeze([
    Object.freeze({ table: 'jogadores', column: 'personagem_aparencia', definition: "TEXT DEFAULT '-'" }),
    Object.freeze({ table: 'jogadores', column: 'personagem_aparencia_normalizada', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'jogadores', column: 'personagem_aparencia_status', definition: "TEXT DEFAULT 'pending'" }),
    Object.freeze({ table: 'jogadores', column: 'personagem_aparencia_motivo', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'jogadores', column: 'personagem_aparencia_image_path', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'jogadores', column: 'personagem_aparencia_image_message_id', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'jogadores', column: 'personagem_aparencia_approved_by', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'jogadores', column: 'personagem_aparencia_approved_at', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'jogadores', column: 'personagem_aparencia_updated_at', definition: 'TEXT DEFAULT NULL' }),
]);

const SITE_PROFILE_IMAGE_TARGETS = Object.freeze([
    Object.freeze({ table: 'jogadores', column: 'site_profile_image_data', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'jogadores', column: 'site_profile_image_updated_at', definition: 'TEXT DEFAULT NULL' }),
]);

const CHARACTER_TRAITS_TARGETS = Object.freeze([
    Object.freeze({ table: 'jogadores', column: 'aptidao_comum', definition: "TEXT DEFAULT '-'" }),
    Object.freeze({ table: 'jogadores', column: 'aptidao_comum_key', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'jogadores', column: 'marca_comum', definition: "TEXT DEFAULT '-'" }),
    Object.freeze({ table: 'jogadores', column: 'marca_comum_key', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'jogadores', column: 'aptidao_rara', definition: "TEXT DEFAULT '-'" }),
    Object.freeze({ table: 'jogadores', column: 'aptidao_rara_key', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'jogadores', column: 'marca_rara', definition: "TEXT DEFAULT '-'" }),
    Object.freeze({ table: 'jogadores', column: 'marca_rara_key', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'jogadores', column: 'anomalia', definition: "TEXT DEFAULT '-'" }),
    Object.freeze({ table: 'jogadores', column: 'anomalia_key', definition: 'TEXT DEFAULT NULL' }),
]);

const ROLL_ATTEMPT_STATE_TARGETS = Object.freeze([
    Object.freeze({ table: 'jogadores', column: 'tentativas_especiais', definition: "TEXT DEFAULT '[]'" }),
    Object.freeze({ table: 'jogadores', column: 'roll_sacrifice_used', definition: 'INTEGER DEFAULT 0' }),
    Object.freeze({ table: 'jogadores', column: 'roll_sacrifice_used_at', definition: 'TEXT DEFAULT NULL' }),
]);

const STORY_STATE_TARGETS = Object.freeze([
    Object.freeze({ table: 'jogadores', column: 'historia_status', definition: "TEXT DEFAULT 'pendente'" }),
    Object.freeze({ table: 'jogadores', column: 'historia_status_updated_at', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'jogadores', column: 'historia_aprovada_at', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'jogadores', column: 'historia_aprovada_by', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'jogadores', column: 'historia_pv_sent_at', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'jogadores', column: 'historia_motivo', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'jogadores', column: 'gancho_narrativo', definition: "TEXT DEFAULT '-'" }),
    Object.freeze({ table: 'jogadores', column: 'historias_extras', definition: "TEXT DEFAULT '[]'" }),
]);

const GAME_STATE_TARGETS = Object.freeze([
    Object.freeze({ table: 'jogadores', column: 'jogo_status', definition: "TEXT DEFAULT 'bloqueado'" }),
    Object.freeze({ table: 'jogadores', column: 'jogo_liberado_at', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'jogadores', column: 'jogo_liberado_by', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'jogadores', column: 'jogo_bloqueio_motivo', definition: 'TEXT DEFAULT NULL' }),
]);

const PLAYER_PATENT_TARGETS = Object.freeze([
    Object.freeze({ table: 'jogadores', column: 'patente', definition: "TEXT DEFAULT '-'" }),
]);

const SQUAD_COLUMNS_TARGETS = Object.freeze([
    Object.freeze({ table: 'clover_squads', column: 'group_id', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_squads', column: 'phrase', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_squads', column: 'captain_name', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_squads', column: 'captain_player_id', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_squads', column: 'vice_captain_player_id', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_squads', column: 'description_synced_at', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_squads', column: 'description_sync_status', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_squads', column: 'description_sync_error', definition: 'TEXT DEFAULT NULL' }),
]);

const RAID_V1_BRIDGE_TARGETS = Object.freeze([
    Object.freeze({ table: 'clover_raids', column: 'raid_key', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_raids', column: 'category', definition: "TEXT DEFAULT 'missao'" }),
    Object.freeze({ table: 'clover_raids', column: 'description', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_raids', column: 'location', definition: "TEXT DEFAULT 'Capital de Clover'" }),
    Object.freeze({ table: 'clover_raids', column: 'owner_player_id', definition: "TEXT DEFAULT 'system'" }),
    Object.freeze({ table: 'clover_raids', column: 'max_players', definition: 'INTEGER NOT NULL DEFAULT 12' }),
    Object.freeze({ table: 'clover_raids', column: 'salary_eligible', definition: 'INTEGER NOT NULL DEFAULT 1' }),
    Object.freeze({ table: 'clover_raids', column: 'rules_json', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_raids', column: 'started_at', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_raids', column: 'finalization_at', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_raids', column: 'completed_at', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_raids', column: 'cancelled_at', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_raids', column: 'cancelled_by', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_raids', column: 'cancellation_reason', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_raid_participants', column: 'joined_via', definition: "TEXT DEFAULT 'site'" }),
    Object.freeze({ table: 'clover_raid_participants', column: 'removed_at', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_raid_participants', column: 'removed_by', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_raid_participants', column: 'removal_reason', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_raid_participants', column: 'snapshot_json', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_raid_participants', column: 'metadata_json', definition: 'TEXT DEFAULT NULL' }),
]);
const RAID_V1_BRIDGE_ALLOWED_RAID_STATUSES = Object.freeze(['lobby', 'in_progress', 'finalization', 'completed', 'cancelled']);
const RAID_V1_BRIDGE_ALLOWED_PARTICIPANT_STATUSES = Object.freeze(['joined', 'active', 'completed', 'removed', 'withdrawn']);

const RAID_V2_COLUMNS_TARGETS = Object.freeze([
    Object.freeze({ table: 'clover_raids', column: 'category_key', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_raids', column: 'category_label', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_raids', column: 'scope_type', definition: "TEXT NOT NULL DEFAULT 'global'" }),
    Object.freeze({ table: 'clover_raids', column: 'scope_player_id', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_raids', column: 'scope_squad_key', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_raids', column: 'month_key', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_raids', column: 'counts_monthly', definition: 'INTEGER NOT NULL DEFAULT 0' }),
    Object.freeze({ table: 'clover_raids', column: 'monthly_limit', definition: 'INTEGER DEFAULT NULL' }),
]);
const RAID_V2_CANONICAL_CATEGORY_KEYS = Object.freeze([
    'saga_pessoal',
    'missao_esquadrao',
    'treino_esquadrao',
    'evento_especial',
]);
const RAID_V2_ALLOWED_SCOPE_TYPES = Object.freeze(['global', 'player', 'squad']);
const RAID_V2_MONTH_TIME_ZONE = 'America/Sao_Paulo';

const RAID_PARTICIPANT_FINALIZATION_TARGETS = Object.freeze([
    Object.freeze({
        table: 'clover_raid_participants',
        column: 'finalization_status',
        definition: "TEXT NOT NULL DEFAULT 'pending'",
    }),
    Object.freeze({
        table: 'clover_raid_participants',
        column: 'finalization_note',
        definition: 'TEXT DEFAULT NULL',
    }),
    Object.freeze({
        table: 'clover_raid_participants',
        column: 'finalized_by',
        definition: 'TEXT DEFAULT NULL',
    }),
    Object.freeze({
        table: 'clover_raid_participants',
        column: 'finalized_at',
        definition: 'TEXT DEFAULT NULL',
    }),
]);
const RAID_PARTICIPANT_FINALIZATION_STORED_STATUSES = Object.freeze([
    'pending',
    'eligible',
    'absent',
    'ineligible',
]);
const RAID_PARTICIPANT_FINALIZATION_INDEX = Object.freeze({
    name: 'idx_clover_raid_participant_finalization',
    table: 'clover_raid_participants',
    columns: Object.freeze(['raid_id', 'finalization_status', 'status', 'id']),
});

const RAID_REWARDS_V1_TABLE_SQL = `
CREATE TABLE clover_raid_rewards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raid_id INTEGER NOT NULL,
    target_type TEXT NOT NULL CHECK (target_type IN ('general', 'player')),
    target_player_id TEXT DEFAULT NULL,
    reward_type TEXT NOT NULL CHECK (reward_type IN ('yulls', 'ph', 'stars', 'catalog_item')),
    amount INTEGER NOT NULL DEFAULT 1 CHECK (amount > 0),
    template_key TEXT DEFAULT NULL,
    label TEXT NOT NULL,
    reason TEXT DEFAULT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'applied', 'cancelled')),
    created_by TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    cancelled_at TEXT DEFAULT NULL,
    cancelled_by TEXT DEFAULT NULL,
    metadata_json TEXT DEFAULT NULL
)
`.trim();

const RAID_REWARDS_V2_TABLE_SQL = `
CREATE TABLE clover_raid_rewards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raid_id INTEGER NOT NULL,
    target_type TEXT NOT NULL CHECK (target_type IN ('general', 'player')),
    target_player_id TEXT DEFAULT NULL,
    reward_type TEXT NOT NULL CHECK (
        reward_type IN ('yulls', 'ph', 'stars', 'catalog_item', 'pa', 'pm', 'box')
    ),
    amount INTEGER NOT NULL DEFAULT 1 CHECK (
        (reward_type = 'pm' AND amount != 0)
        OR (reward_type != 'pm' AND amount > 0)
    ),
    template_key TEXT DEFAULT NULL,
    resource_key TEXT DEFAULT NULL,
    label TEXT NOT NULL,
    reason TEXT DEFAULT NULL,
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'applied', 'cancelled')),
    created_by TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    cancelled_at TEXT DEFAULT NULL,
    cancelled_by TEXT DEFAULT NULL,
    metadata_json TEXT DEFAULT NULL
)
`.trim();

const RAID_REWARDS_V2_INDEX = Object.freeze({
    name: 'idx_clover_raid_rewards_raid',
    table: 'clover_raid_rewards',
    columns: Object.freeze(['raid_id', 'status', 'id']),
});

const RAID_REWARDS_V1_REWARD_TYPES = Object.freeze([
    'yulls', 'ph', 'stars', 'catalog_item',
]);
const RAID_REWARDS_V2_REWARD_TYPES = Object.freeze([
    'yulls', 'ph', 'stars', 'catalog_item', 'pa', 'pm', 'box',
]);

function normalizeRaidRewardsSchemaSql(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

async function inspectRaidRewardsSchemaState(db) {
    const table = await db.get(
        `SELECT name, sql
         FROM sqlite_schema
         WHERE type = 'table' AND name = 'clover_raid_rewards'`
    );
    if (!table) {
        return Object.freeze({
            kind: 'missing',
            tableSql: null,
            indexValid: false,
            indexColumns: Object.freeze([]),
            unexpectedIndexes: Object.freeze([]),
            triggers: Object.freeze([]),
            dependentSchemaObjects: Object.freeze([]),
            inboundForeignKeys: Object.freeze([]),
        });
    }

    const observedSql = normalizeRaidRewardsSchemaSql(table.sql);
    const v1Sql = normalizeRaidRewardsSchemaSql(RAID_REWARDS_V1_TABLE_SQL);
    const v2Sql = normalizeRaidRewardsSchemaSql(RAID_REWARDS_V2_TABLE_SQL);
    const kind = observedSql === v1Sql
        ? 'v1'
        : (observedSql === v2Sql ? 'v2' : 'unknown');

    const indexRows = await db.all('PRAGMA index_list(clover_raid_rewards)');
    const canonicalIndex = indexRows.find((row) => row.name === RAID_REWARDS_V2_INDEX.name);
    const unexpectedIndexes = indexRows
        .filter((row) => row.name !== RAID_REWARDS_V2_INDEX.name)
        .map((row) => Object.freeze({
            name: row.name,
            unique: Number(row.unique || 0),
            origin: String(row.origin || ''),
            partial: Number(row.partial || 0),
        }));
    const indexColumns = canonicalIndex
        ? (await db.all(`PRAGMA index_info(${RAID_REWARDS_V2_INDEX.name})`))
            .sort((a, b) => Number(a.seqno) - Number(b.seqno))
            .map((row) => row.name)
        : [];
    const indexValid = Boolean(
        canonicalIndex
        && Number(canonicalIndex.unique || 0) === 0
        && String(canonicalIndex.origin || '') === 'c'
        && Number(canonicalIndex.partial || 0) === 0
        && indexColumns.length === RAID_REWARDS_V2_INDEX.columns.length
        && indexColumns.every((column, index) => column === RAID_REWARDS_V2_INDEX.columns[index])
    );

    const triggers = (await db.all(
        `SELECT name, sql
         FROM sqlite_schema
         WHERE type = 'trigger' AND tbl_name = 'clover_raid_rewards'
         ORDER BY name`
    )).map((row) => Object.freeze({
        name: row.name,
        sql: normalizeRaidRewardsSchemaSql(row.sql),
    }));

    const dependentSchemaObjects = (await db.all(
        `SELECT type, name, sql
         FROM sqlite_schema
         WHERE type IN ('view', 'trigger')
           AND tbl_name <> 'clover_raid_rewards'
           AND sql IS NOT NULL
           AND LOWER(sql) LIKE '%clover_raid_rewards%'
         ORDER BY type, name`
    )).map((row) => Object.freeze({
        type: row.type,
        name: row.name,
        sql: normalizeRaidRewardsSchemaSql(row.sql),
    }));

    const inboundForeignKeys = [];
    const tables = await db.all(
        `SELECT name
         FROM sqlite_schema
         WHERE type = 'table'
           AND name NOT LIKE 'sqlite_%'
           AND name <> 'clover_raid_rewards'
         ORDER BY name`
    );
    for (const row of tables) {
        const quoted = String(row.name).replace(/"/g, '""');
        const foreignKeys = await db.all(`PRAGMA foreign_key_list("${quoted}")`);
        for (const foreignKey of foreignKeys) {
            if (String(foreignKey.table || '') === 'clover_raid_rewards') {
                inboundForeignKeys.push(Object.freeze({
                    table: row.name,
                    id: Number(foreignKey.id),
                    seq: Number(foreignKey.seq),
                    from: foreignKey.from,
                    to: foreignKey.to,
                }));
            }
        }
    }

    return Object.freeze({
        kind,
        tableSql: observedSql,
        indexValid,
        indexColumns: Object.freeze(indexColumns),
        unexpectedIndexes: Object.freeze(unexpectedIndexes),
        triggers: Object.freeze(triggers),
        dependentSchemaObjects: Object.freeze(dependentSchemaObjects),
        inboundForeignKeys: Object.freeze(inboundForeignKeys),
    });
}

const RAID_MONTHLY_RESERVATIONS_TABLE_SQL = `
CREATE TABLE clover_raid_monthly_reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raid_id INTEGER NOT NULL,
    category_key TEXT NOT NULL,
    month_key TEXT NOT NULL,
    scope_type TEXT NOT NULL CHECK (scope_type IN ('player', 'squad')),
    scope_key TEXT NOT NULL,
    participant_id INTEGER DEFAULT NULL,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'released', 'consumed')),
    created_by TEXT DEFAULT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    released_at TEXT DEFAULT NULL,
    consumed_at TEXT DEFAULT NULL,
    release_reason TEXT DEFAULT NULL,
    metadata_json TEXT DEFAULT NULL,
    UNIQUE (raid_id, category_key, month_key, scope_type, scope_key)
)
`.trim();

const RAID_MONTHLY_LEDGER_TABLE_SQL = `
CREATE TABLE clover_raid_monthly_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_key TEXT NOT NULL UNIQUE,
    raid_id INTEGER DEFAULT NULL,
    category_key TEXT NOT NULL,
    month_key TEXT NOT NULL,
    scope_type TEXT NOT NULL CHECK (scope_type IN ('player', 'squad')),
    scope_key TEXT NOT NULL,
    participant_id INTEGER DEFAULT NULL,
    amount INTEGER NOT NULL CHECK (amount != 0),
    kind TEXT NOT NULL CHECK (kind IN ('completion', 'adjustment', 'reversal')),
    reason TEXT DEFAULT NULL,
    operation_code TEXT DEFAULT NULL,
    reversed_entry_id INTEGER DEFAULT NULL,
    created_by TEXT DEFAULT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    metadata_json TEXT DEFAULT NULL
)
`.trim();

const RAID_MONTHLY_PROGRESS_INDEXES = Object.freeze([
    Object.freeze({
        name: 'idx_clover_raid_monthly_reservation_scope',
        table: 'clover_raid_monthly_reservations',
        columns: Object.freeze([
            'category_key', 'month_key', 'scope_type', 'scope_key', 'status', 'raid_id',
        ]),
        sql: `
CREATE INDEX idx_clover_raid_monthly_reservation_scope
ON clover_raid_monthly_reservations (
    category_key, month_key, scope_type, scope_key, status, raid_id
)
`.trim(),
    }),
    Object.freeze({
        name: 'idx_clover_raid_monthly_reservation_raid',
        table: 'clover_raid_monthly_reservations',
        columns: Object.freeze(['raid_id', 'status', 'id']),
        sql: `
CREATE INDEX idx_clover_raid_monthly_reservation_raid
ON clover_raid_monthly_reservations (raid_id, status, id)
`.trim(),
    }),
    Object.freeze({
        name: 'idx_clover_raid_monthly_ledger_scope',
        table: 'clover_raid_monthly_ledger',
        columns: Object.freeze([
            'category_key', 'month_key', 'scope_type', 'scope_key', 'created_at DESC', 'id DESC',
        ]),
        sql: `
CREATE INDEX idx_clover_raid_monthly_ledger_scope
ON clover_raid_monthly_ledger (
    category_key, month_key, scope_type, scope_key, created_at DESC, id DESC
)
`.trim(),
    }),
    Object.freeze({
        name: 'idx_clover_raid_monthly_ledger_raid',
        table: 'clover_raid_monthly_ledger',
        columns: Object.freeze(['raid_id', 'created_at DESC', 'id DESC']),
        sql: `
CREATE INDEX idx_clover_raid_monthly_ledger_raid
ON clover_raid_monthly_ledger (raid_id, created_at DESC, id DESC)
`.trim(),
    }),
]);

function normalizeRaidMonthlySchemaSql(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

async function inspectRaidMonthlyProgressSchemaState(db) {
    const tableSpecs = [
        { name: 'clover_raid_monthly_reservations', sql: RAID_MONTHLY_RESERVATIONS_TABLE_SQL },
        { name: 'clover_raid_monthly_ledger', sql: RAID_MONTHLY_LEDGER_TABLE_SQL },
    ];
    const tables = [];
    for (const spec of tableSpecs) {
        const row = await db.get(
            `SELECT name, sql
             FROM sqlite_schema
             WHERE type = 'table' AND name = ?`,
            [spec.name]
        );
        const observedSql = row ? normalizeRaidMonthlySchemaSql(row.sql) : null;
        tables.push(Object.freeze({
            name: spec.name,
            exists: Boolean(row),
            exact: Boolean(row)
                && observedSql === normalizeRaidMonthlySchemaSql(spec.sql),
            observedSql,
        }));
    }

    const presentCount = tables.filter((entry) => entry.exists).length;
    const exactCount = tables.filter((entry) => entry.exact).length;
    const kind = presentCount === 0
        ? 'missing'
        : (presentCount !== tableSpecs.length
            ? 'partial'
            : (exactCount === tableSpecs.length ? 'exact' : 'unknown'));

    const indexes = [];
    for (const spec of RAID_MONTHLY_PROGRESS_INDEXES) {
        const row = await db.get(
            `SELECT name, tbl_name, sql
             FROM sqlite_schema
             WHERE type = 'index' AND name = ?`,
            [spec.name]
        );
        const observedSql = row ? normalizeRaidMonthlySchemaSql(row.sql) : null;
        indexes.push(Object.freeze({
            name: spec.name,
            table: spec.table,
            exists: Boolean(row),
            valid: Boolean(row)
                && row.tbl_name === spec.table
                && observedSql === normalizeRaidMonthlySchemaSql(spec.sql),
            observedTable: row?.tbl_name || null,
            observedSql,
        }));
    }

    return Object.freeze({
        kind,
        tables: Object.freeze(tables),
        indexValid: indexes.every((entry) => entry.valid),
        indexes: Object.freeze(indexes),
    });
}

async function assertRaidMonthlyStoredStateCompatible(db) {
    const invalidReservation = await db.get(
        `SELECT id, scope_type, status
         FROM clover_raid_monthly_reservations
         WHERE scope_type NOT IN ('player', 'squad')
            OR status NOT IN ('active', 'released', 'consumed')
         ORDER BY id
         LIMIT 1`
    );
    if (invalidReservation) {
        const error = new Error(
            'Reserva mensal contem estado que exige reconciliacao explicita antes da migration 0024: id='
            + invalidReservation.id
        );
        error.code = 'raid_monthly_state_mapping_required';
        error.table = 'clover_raid_monthly_reservations';
        error.rowId = Number(invalidReservation.id);
        error.observed = invalidReservation;
        throw error;
    }

    const invalidLedger = await db.get(
        `SELECT id, scope_type, amount, kind
         FROM clover_raid_monthly_ledger
         WHERE scope_type NOT IN ('player', 'squad')
            OR amount = 0
            OR kind NOT IN ('completion', 'adjustment', 'reversal')
         ORDER BY id
         LIMIT 1`
    );
    if (invalidLedger) {
        const error = new Error(
            'Ledger mensal contem estado que exige reconciliacao explicita antes da migration 0024: id='
            + invalidLedger.id
        );
        error.code = 'raid_monthly_state_mapping_required';
        error.table = 'clover_raid_monthly_ledger';
        error.rowId = Number(invalidLedger.id);
        error.observed = invalidLedger;
        throw error;
    }
}

function raidV2MigrationMonthKey(value) {
    const text = String(value || '').trim();
    if (!text) return null;

    let date = null;
    const sqlite = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
    if (sqlite) {
        const year = Number(sqlite[1]);
        const month = Number(sqlite[2]);
        const day = Number(sqlite[3]);
        const hour = Number(sqlite[4]);
        const minute = Number(sqlite[5]);
        const second = Number(sqlite[6] || 0);
        const millis = Number(String(sqlite[7] || '0').padEnd(3, '0'));
        date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millis));
        if (
            date.getUTCFullYear() !== year
            || date.getUTCMonth() !== month - 1
            || date.getUTCDate() !== day
            || date.getUTCHours() !== hour
            || date.getUTCMinutes() !== minute
            || date.getUTCSeconds() !== second
        ) return null;
    } else if (/^\d{4}-\d{2}-\d{2}T/.test(text) && /(Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
        date = new Date(text);
    } else {
        return null;
    }

    if (!date || Number.isNaN(date.getTime())) return null;
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: RAID_V2_MONTH_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
    });
    const parts = Object.fromEntries(
        formatter.formatToParts(date)
            .filter((part) => part.type !== 'literal')
            .map((part) => [part.type, part.value])
    );
    if (!parts.year || !parts.month) return null;
    return `${parts.year}-${parts.month}`;
}

const MARKET_REQUEST_MIGRATION = Object.freeze(
    {
        version: MARKET_REQUEST_VERSION,
        key: MARKET_REQUEST_KEY,
        description: 'Versiona idempotência de mercado e requisitos semanais de NPC antes da retirada gradual de ensureColumn.',
        checksumMaterial: MARKET_REQUEST_TARGETS,
        async up(db) {
            for (const target of MARKET_REQUEST_TARGETS) {
                await addColumnIfMissing(db, target);
            }
        },
    }
);

const QUICK_EVALUATION_MIGRATION = Object.freeze(
    {
        version: QUICK_EVALUATION_VERSION,
        key: QUICK_EVALUATION_KEY,
        description: 'Versiona seis colunas legadas de avaliações rápidas antes da retirada gradual de ensureColumn.',
        checksumMaterial: QUICK_EVALUATION_TARGETS,
        async up(db) {
            for (const target of QUICK_EVALUATION_TARGETS) {
                await addColumnIfMissing(db, target);
            }
        },
    }
);

const PLAYER_ROLLS_MIGRATION = Object.freeze(
    {
        version: PLAYER_ROLLS_VERSION,
        key: PLAYER_ROLLS_KEY,
        description: 'Versiona onze colunas legadas de player_rolls antes da retirada gradual de ensureColumn.',
        checksumMaterial: PLAYER_ROLLS_TARGETS,
        async up(db) {
            for (const target of PLAYER_ROLLS_TARGETS) {
                await addColumnIfMissing(db, target);
            }
        },
    }
);

const ITEM_TEMPLATES_MIGRATION = Object.freeze(
    {
        version: ITEM_TEMPLATES_VERSION,
        key: ITEM_TEMPLATES_KEY,
        description: 'Versiona sete colunas legadas de clover_item_templates antes da retirada gradual de ensureColumn.',
        checksumMaterial: ITEM_TEMPLATES_TARGETS,
        async up(db) {
            for (const target of ITEM_TEMPLATES_TARGETS) {
                await addColumnIfMissing(db, target);
            }
        },
    }
);

const INVENTORY_ITEMS_MIGRATION = Object.freeze(
    {
        version: INVENTORY_ITEMS_VERSION,
        key: INVENTORY_ITEMS_KEY,
        description: 'Versiona dezessete colunas legadas de clover_inventory_items sem executar normalização de dados.',
        checksumMaterial: INVENTORY_ITEMS_TARGETS,
        async up(db) {
            for (const target of INVENTORY_ITEMS_TARGETS) {
                await addColumnIfMissing(db, target);
            }
        },
    }
);

const ADMIN_SERVICE_MIGRATION = Object.freeze(
    {
        version: ADMIN_SERVICE_VERSION,
        key: ADMIN_SERVICE_KEY,
        description: 'Versiona treze colunas legadas de clover_admin_service_entries antes da retirada gradual de ensureColumn.',
        checksumMaterial: ADMIN_SERVICE_TARGETS,
        async up(db) {
            for (const target of ADMIN_SERVICE_TARGETS) {
                await addColumnIfMissing(db, target);
            }
        },
    }
);

const PLAYER_PROFILE_MIGRATION = Object.freeze(
    {
        version: PLAYER_PROFILE_VERSION,
        key: PLAYER_PROFILE_KEY,
        description: 'Versiona cinco colunas legadas de perfil humano de jogadores antes da retirada gradual de ensureColumn.',
        checksumMaterial: PLAYER_PROFILE_TARGETS,
        async up(db) {
            for (const target of PLAYER_PROFILE_TARGETS) {
                await addColumnIfMissing(db, target);
            }
        },
    }
);

const CHARACTER_IDENTITY_MIGRATION = Object.freeze(
    {
        version: CHARACTER_IDENTITY_VERSION,
        key: CHARACTER_IDENTITY_KEY,
        description: 'Versiona oito colunas legadas de identidade e onboarding do personagem em jogadores antes da retirada gradual de ensureColumn.',
        checksumMaterial: CHARACTER_IDENTITY_TARGETS,
        async up(db) {
            for (const target of CHARACTER_IDENTITY_TARGETS) {
                await addColumnIfMissing(db, target);
            }
        },
    }
);

const APPEARANCE_MODERATION_MIGRATION = Object.freeze(
    {
        version: APPEARANCE_MODERATION_VERSION,
        key: APPEARANCE_MODERATION_KEY,
        description: 'Versiona nove colunas legadas do workflow de moderação de aparência em jogadores sem alterar estado ou dados.',
        checksumMaterial: APPEARANCE_MODERATION_TARGETS,
        async up(db) {
            for (const target of APPEARANCE_MODERATION_TARGETS) {
                await addColumnIfMissing(db, target);
            }
        },
    }
);
const SITE_PROFILE_IMAGE_MIGRATION = Object.freeze(
    {
        version: SITE_PROFILE_IMAGE_VERSION,
        key: SITE_PROFILE_IMAGE_KEY,
        description: 'Versiona duas colunas legadas de avatar do site em jogadores sem alterar imagem ou metadados.',
        checksumMaterial: SITE_PROFILE_IMAGE_TARGETS,
        async up(db) {
            for (const target of SITE_PROFILE_IMAGE_TARGETS) {
                await addColumnIfMissing(db, target);
            }
        },
    }
);

const CHARACTER_TRAITS_MIGRATION = Object.freeze(
    {
        version: CHARACTER_TRAITS_VERSION,
        key: CHARACTER_TRAITS_KEY,
        description: 'Versiona dez colunas legadas de traços canônicos do personagem em jogadores sem normalizar conteúdo ou keys.',
        checksumMaterial: CHARACTER_TRAITS_TARGETS,
        async up(db) {
            for (const target of CHARACTER_TRAITS_TARGETS) {
                await addColumnIfMissing(db, target);
            }
        },
    }
);

const ROLL_ATTEMPT_STATE_MIGRATION = Object.freeze(
    {
        version: ROLL_ATTEMPT_STATE_VERSION,
        key: ROLL_ATTEMPT_STATE_KEY,
        description: 'Versiona três colunas legadas de tentativas e sacrifício de roll em jogadores sem consumir, resetar ou normalizar estado.',
        checksumMaterial: ROLL_ATTEMPT_STATE_TARGETS,
        async up(db) {
            for (const target of ROLL_ATTEMPT_STATE_TARGETS) {
                await addColumnIfMissing(db, target);
            }
        },
    }
);

const STORY_STATE_MIGRATION = Object.freeze(
    {
        version: STORY_STATE_VERSION,
        key: STORY_STATE_KEY,
        description: 'Versiona oito colunas legadas do workflow e conteúdo de história em jogadores sem aprovar, negar ou normalizar dados.',
        checksumMaterial: STORY_STATE_TARGETS,
        async up(db) {
            for (const target of STORY_STATE_TARGETS) {
                await addColumnIfMissing(db, target);
            }
        },
    }
);

const GAME_STATE_MIGRATION = Object.freeze(
    {
        version: GAME_STATE_VERSION,
        key: GAME_STATE_KEY,
        description: 'Versiona quatro colunas legadas de liberação e bloqueio de jogo em jogadores sem alterar acesso ou metadata histórica.',
        checksumMaterial: GAME_STATE_TARGETS,
        async up(db) {
            for (const target of GAME_STATE_TARGETS) {
                await addColumnIfMissing(db, target);
            }
        },
    }
);

const PLAYER_PATENT_MIGRATION = Object.freeze(
    {
        version: PLAYER_PATENT_VERSION,
        key: PLAYER_PATENT_KEY,
        description: 'Versiona a coluna legada de patente em jogadores sem promover, rebaixar ou normalizar progressão.',
        checksumMaterial: PLAYER_PATENT_TARGETS,
        async up(db) {
            for (const target of PLAYER_PATENT_TARGETS) {
                await addColumnIfMissing(db, target);
            }
        },
    }
);

const SQUAD_COLUMNS_MIGRATION = Object.freeze(
    {
        version: SQUAD_COLUMNS_VERSION,
        key: SQUAD_COLUMNS_KEY,
        description: 'Versiona oito colunas legadas de integração, comando e sincronização de clover_squads sem alterar membros, estrelas ou vínculos.',
        checksumMaterial: SQUAD_COLUMNS_TARGETS,
        async up(db) {
            for (const target of SQUAD_COLUMNS_TARGETS) {
                await addColumnIfMissing(db, target);
            }
        },
    }
);


const RAID_V1_BRIDGE_MIGRATION = Object.freeze(
    {
        version: RAID_V1_BRIDGE_VERSION,
        key: RAID_V1_BRIDGE_KEY,
        description: 'Versiona o bridge estrutural V1 de Raid sem mapear status pré-V1, sem tocar rewards, V2, finalização ou progresso mensal.',
        checksumMaterial: Object.freeze({
            targets: RAID_V1_BRIDGE_TARGETS,
            raidStatuses: RAID_V1_BRIDGE_ALLOWED_RAID_STATUSES,
            participantStatuses: RAID_V1_BRIDGE_ALLOWED_PARTICIPANT_STATUSES,
            revision: 'raid-v1-bridge-fail-closed-v1',
        }),
        async up(db) {
            const raidColumnsBeforeRows = await db.all('PRAGMA table_info(clover_raids)');
            const participantColumnsBeforeRows = await db.all('PRAGMA table_info(clover_raid_participants)');
            if (!raidColumnsBeforeRows.length) {
                const error = new Error('Tabela obrigatória ausente para bridge V1 de Raid: clover_raids.');
                error.code = 'migration_precondition_failed';
                error.table = 'clover_raids';
                throw error;
            }
            if (!participantColumnsBeforeRows.length) {
                const error = new Error('Tabela obrigatória ausente para bridge V1 de Raid: clover_raid_participants.');
                error.code = 'migration_precondition_failed';
                error.table = 'clover_raid_participants';
                throw error;
            }

            const raidColumnsBefore = new Set(raidColumnsBeforeRows.map((row) => row.name));
            const participantColumnsBefore = new Set(participantColumnsBeforeRows.map((row) => row.name));
            for (const required of ['id', 'status', 'created_at', 'updated_at']) {
                if (!raidColumnsBefore.has(required)) {
                    const error = new Error('Schema base de clover_raids incompatível com bridge V1: coluna ' + required + ' ausente.');
                    error.code = 'raid_v1_bridge_base_incompatible';
                    error.table = 'clover_raids';
                    error.column = required;
                    throw error;
                }
            }
            if (!participantColumnsBefore.has('status')) {
                const error = new Error('Schema base de clover_raid_participants incompatível com bridge V1: status ausente.');
                error.code = 'raid_v1_bridge_base_incompatible';
                error.table = 'clover_raid_participants';
                error.column = 'status';
                throw error;
            }

            const raidStatusRows = await db.all(
                "SELECT DISTINCT status FROM clover_raids WHERE status IS NOT NULL AND TRIM(status) <> '' ORDER BY status"
            );
            const unsupportedRaidStatuses = raidStatusRows
                .map((row) => String(row.status))
                .filter((status) => !RAID_V1_BRIDGE_ALLOWED_RAID_STATUSES.includes(status));
            if (unsupportedRaidStatuses.length) {
                const error = new Error(
                    'Status pré-V1 de Raid exigem mapeamento explícito antes da migration 0020: '
                    + unsupportedRaidStatuses.join(', ')
                );
                error.code = 'raid_v1_status_mapping_required';
                error.table = 'clover_raids';
                error.statuses = unsupportedRaidStatuses;
                throw error;
            }

            const participantStatusRows = await db.all(
                "SELECT DISTINCT status FROM clover_raid_participants WHERE status IS NOT NULL AND TRIM(status) <> '' ORDER BY status"
            );
            const unsupportedParticipantStatuses = participantStatusRows
                .map((row) => String(row.status))
                .filter((status) => !RAID_V1_BRIDGE_ALLOWED_PARTICIPANT_STATUSES.includes(status));
            if (unsupportedParticipantStatuses.length) {
                const error = new Error(
                    'Status pré-V1 de participantes exigem mapeamento explícito antes da migration 0020: '
                    + unsupportedParticipantStatuses.join(', ')
                );
                error.code = 'raid_v1_status_mapping_required';
                error.table = 'clover_raid_participants';
                error.statuses = unsupportedParticipantStatuses;
                throw error;
            }

            for (const target of RAID_V1_BRIDGE_TARGETS) {
                await addColumnIfMissing(db, target);
            }

            const hasLegacyCode = raidColumnsBefore.has('code');
            const hasLegacyCreatedBy = raidColumnsBefore.has('created_by');
            const hasLegacySlots = raidColumnsBefore.has('slots');
            const raidKeyExpression = hasLegacyCode
                ? "COALESCE(NULLIF(raid_key, ''), NULLIF(code, ''), 'raid-' || id)"
                : "COALESCE(NULLIF(raid_key, ''), 'raid-' || id)";
            const ownerExpression = raidColumnsBefore.has('owner_player_id')
                ? (hasLegacyCreatedBy
                    ? "COALESCE(NULLIF(owner_player_id, ''), NULLIF(created_by, ''), 'system')"
                    : "COALESCE(NULLIF(owner_player_id, ''), 'system')")
                : (hasLegacyCreatedBy ? "COALESCE(NULLIF(created_by, ''), 'system')" : "'system'");
            const maxPlayersExpression = raidColumnsBefore.has('max_players')
                ? (hasLegacySlots
                    ? 'COALESCE(NULLIF(max_players, 0), NULLIF(slots, 0), 12)'
                    : 'COALESCE(NULLIF(max_players, 0), 12)')
                : (hasLegacySlots ? 'COALESCE(NULLIF(slots, 0), 12)' : '12');

            await db.run(
                `UPDATE clover_raids
                 SET raid_key = ${raidKeyExpression},
                     category = COALESCE(NULLIF(category, ''), 'missao'),
                     owner_player_id = ${ownerExpression},
                     max_players = ${maxPlayersExpression},
                     updated_at = COALESCE(updated_at, created_at, CURRENT_TIMESTAMP)`
            );

            await db.exec(`
                CREATE UNIQUE INDEX IF NOT EXISTS idx_clover_raids_raid_key
                ON clover_raids (raid_key)
                WHERE raid_key IS NOT NULL
            `);
        },
    }
);



const RAID_V2_COLUMNS_MIGRATION = Object.freeze(
    {
        version: RAID_V2_COLUMNS_VERSION,
        key: RAID_V2_COLUMNS_KEY,
        description: 'Versiona somente oito colunas V2 de clover_raids e sua normalizacao nao retroativa, sem tocar finalizacao, rewards ou tabelas mensais.',
        checksumMaterial: Object.freeze({
            targets: RAID_V2_COLUMNS_TARGETS,
            categories: RAID_V2_CANONICAL_CATEGORY_KEYS,
            scopes: RAID_V2_ALLOWED_SCOPE_TYPES,
            monthTimeZone: RAID_V2_MONTH_TIME_ZONE,
            monthParser: String(raidV2MigrationMonthKey),
            revision: 'raid-v2-columns-fail-closed-v1',
        }),
        async up(db) {
            const raidColumnsBeforeRows = await db.all('PRAGMA table_info(clover_raids)');
            if (!raidColumnsBeforeRows.length) {
                const error = new Error('Tabela obrigatoria ausente para Raid V2: clover_raids.');
                error.code = 'migration_precondition_failed';
                error.table = 'clover_raids';
                throw error;
            }

            const raidColumnsBefore = new Set(raidColumnsBeforeRows.map((row) => row.name));
            for (const required of ['id', 'category', 'status', 'created_at']) {
                if (!raidColumnsBefore.has(required)) {
                    const error = new Error('Schema base de clover_raids incompativel com Raid V2: coluna ' + required + ' ausente.');
                    error.code = 'raid_v2_base_incompatible';
                    error.table = 'clover_raids';
                    error.column = required;
                    throw error;
                }
            }

            for (const target of RAID_V2_COLUMNS_TARGETS) {
                await addColumnIfMissing(db, target);
            }

            const legacyRows = await db.all(
                `SELECT id, created_at
                 FROM clover_raids
                 WHERE category_key IS NULL OR TRIM(category_key) = ''
                 ORDER BY id`
            );
            for (const row of legacyRows) {
                const monthKey = raidV2MigrationMonthKey(row.created_at);
                if (!monthKey) {
                    const error = new Error(
                        'Raid sem V2 possui created_at que exige reconciliacao explicita antes da migration 0021: id=' + row.id
                    );
                    error.code = 'raid_v2_month_mapping_required';
                    error.raidId = Number(row.id);
                    throw error;
                }
                await db.run(
                    `UPDATE clover_raids
                     SET category_key = 'evento_especial',
                         category_label = 'Evento especial',
                         scope_type = 'global',
                         scope_player_id = NULL,
                         scope_squad_key = NULL,
                         month_key = ?,
                         counts_monthly = 0,
                         monthly_limit = NULL
                     WHERE id = ?`,
                    [monthKey, row.id]
                );
            }

            await db.run(
                `UPDATE clover_raids
                 SET category = 'saga_pessoal',
                     category_key = 'saga_pessoal',
                     category_label = 'Saga individual / Missao de desenvolvimento',
                     monthly_limit = CASE WHEN counts_monthly = 1 THEN 1 ELSE NULL END
                 WHERE category_key = 'missao_desenvolvimento'
                   AND scope_type = 'player'
                   AND scope_player_id IS NOT NULL
                   AND TRIM(scope_player_id) <> ''`
            );

            await db.run(
                `UPDATE clover_raids
                 SET category = 'evento_especial',
                     category_key = 'evento_especial',
                     category_label = 'Evento especial',
                     counts_monthly = 0,
                     monthly_limit = NULL
                 WHERE scope_type = 'global'
                   AND counts_monthly = 0
                   AND category_key IN (
                       'saga_pessoal', 'missao_desenvolvimento',
                       'missao_esquadrao', 'treino_esquadrao'
                   )`
            );

            const rows = await db.all(
                `SELECT id, category_key, category_label, scope_type,
                        scope_player_id, scope_squad_key, month_key,
                        counts_monthly, monthly_limit
                 FROM clover_raids
                 ORDER BY id`
            );
            for (const row of rows) {
                const key = String(row.category_key || '').trim();
                const scopeType = String(row.scope_type || '').trim();
                const monthKey = String(row.month_key || '').trim();
                const countsMonthly = Number(row.counts_monthly);
                const monthlyLimit = row.monthly_limit === null ? null : Number(row.monthly_limit);
                let reason = null;

                if (!RAID_V2_CANONICAL_CATEGORY_KEYS.includes(key)) {
                    reason = 'category_key';
                } else if (!RAID_V2_ALLOWED_SCOPE_TYPES.includes(scopeType)) {
                    reason = 'scope_type';
                } else if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey)) {
                    reason = 'month_key';
                } else if (![0, 1].includes(countsMonthly)) {
                    reason = 'counts_monthly';
                } else if (monthlyLimit !== null && (!Number.isInteger(monthlyLimit) || monthlyLimit <= 0)) {
                    reason = 'monthly_limit';
                } else if (key === 'evento_especial' && (scopeType !== 'global' || countsMonthly !== 0)) {
                    reason = 'evento_especial_scope';
                } else if (
                    key === 'saga_pessoal'
                    && (scopeType !== 'player' || !String(row.scope_player_id || '').trim())
                ) {
                    reason = 'saga_pessoal_scope';
                } else if (
                    ['missao_esquadrao', 'treino_esquadrao'].includes(key)
                    && (scopeType !== 'squad' || !String(row.scope_squad_key || '').trim())
                ) {
                    reason = 'squad_scope';
                }

                if (reason) {
                    const error = new Error(
                        'Estado V2 parcial/incompativel exige reconciliacao explicita antes da migration 0021: id='
                        + row.id + ', motivo=' + reason
                    );
                    error.code = 'raid_v2_state_mapping_required';
                    error.raidId = Number(row.id);
                    error.reason = reason;
                    throw error;
                }
            }

            await db.exec(`
                CREATE INDEX IF NOT EXISTS idx_clover_raids_monthly_scope
                ON clover_raids (
                    category_key, month_key, scope_type,
                    scope_player_id, scope_squad_key, status
                )
            `);
        },
    }
);


const RAID_PARTICIPANT_FINALIZATION_MIGRATION = Object.freeze(
    {
        version: RAID_PARTICIPANT_FINALIZATION_VERSION,
        key: RAID_PARTICIPANT_FINALIZATION_KEY,
        description: 'Versiona somente quatro colunas de finalizacao de participantes da Raid, valida estado armazenado sem reescrever legado e garante o indice operacional.',
        checksumMaterial: Object.freeze({
            targets: RAID_PARTICIPANT_FINALIZATION_TARGETS,
            storedStatuses: RAID_PARTICIPANT_FINALIZATION_STORED_STATUSES,
            index: RAID_PARTICIPANT_FINALIZATION_INDEX,
            legacyCompatibility: 'completed+pending_is_preserved_and_read_as_eligible_legacy_by_runtime',
            revision: 'raid-participant-finalization-ddl-only-fail-closed-v1',
        }),
        async up(db) {
            const beforeRows = await db.all('PRAGMA table_info(clover_raid_participants)');
            if (!beforeRows.length) {
                const error = new Error('Tabela obrigatoria ausente para finalizacao de Raid: clover_raid_participants.');
                error.code = 'migration_precondition_failed';
                error.table = 'clover_raid_participants';
                throw error;
            }

            const beforeColumns = new Set(beforeRows.map((row) => row.name));
            for (const required of ['id', 'raid_id', 'player_id', 'status']) {
                if (!beforeColumns.has(required)) {
                    const error = new Error(
                        'Schema base de clover_raid_participants incompativel com finalizacao: coluna '
                        + required + ' ausente.'
                    );
                    error.code = 'raid_finalization_base_incompatible';
                    error.table = 'clover_raid_participants';
                    error.column = required;
                    throw error;
                }
            }

            for (const target of RAID_PARTICIPANT_FINALIZATION_TARGETS) {
                await addColumnIfMissing(db, target);
            }

            const afterRows = await db.all('PRAGMA table_info(clover_raid_participants)');
            const afterByName = new Map(afterRows.map((row) => [row.name, row]));
            const expectedShape = Object.freeze({
                finalization_status: Object.freeze({ type: 'TEXT', notnull: 1, defaultValue: "'pending'" }),
                finalization_note: Object.freeze({ type: 'TEXT', notnull: 0, defaultValue: 'NULL' }),
                finalized_by: Object.freeze({ type: 'TEXT', notnull: 0, defaultValue: 'NULL' }),
                finalized_at: Object.freeze({ type: 'TEXT', notnull: 0, defaultValue: 'NULL' }),
            });
            for (const [column, expected] of Object.entries(expectedShape)) {
                const observed = afterByName.get(column);
                const observedType = String(observed?.type || '').trim().toUpperCase();
                const observedDefault = observed?.dflt_value === null || observed?.dflt_value === undefined
                    ? null
                    : String(observed.dflt_value).trim();
                if (
                    !observed
                    || observedType !== expected.type
                    || Number(observed.notnull || 0) !== expected.notnull
                    || observedDefault !== expected.defaultValue
                ) {
                    const error = new Error(
                        'Schema parcial de finalizacao exige reconciliacao explicita: coluna=' + column
                    );
                    error.code = 'raid_finalization_schema_mapping_required';
                    error.table = 'clover_raid_participants';
                    error.column = column;
                    error.observed = observed || null;
                    throw error;
                }
            }

            const invalid = await db.get(
                `SELECT id, finalization_status
                 FROM clover_raid_participants
                 WHERE LOWER(TRIM(COALESCE(finalization_status, ''))) NOT IN (
                     'pending', 'eligible', 'absent', 'ineligible'
                 )
                 ORDER BY id
                 LIMIT 1`
            );
            if (invalid) {
                const error = new Error(
                    'Status de finalizacao exige reconciliacao explicita antes da migration 0022: participant_id='
                    + invalid.id
                );
                error.code = 'raid_finalization_state_mapping_required';
                error.participantId = Number(invalid.id);
                error.observedStatus = invalid.finalization_status;
                throw error;
            }

            await db.exec(`
                CREATE INDEX IF NOT EXISTS idx_clover_raid_participant_finalization
                ON clover_raid_participants (raid_id, finalization_status, status, id)
            `);

            const indexRow = await db.get(
                `SELECT name, tbl_name
                 FROM sqlite_schema
                 WHERE type = 'index' AND name = 'idx_clover_raid_participant_finalization'`
            );
            const indexColumns = await db.all(
                'PRAGMA index_info(idx_clover_raid_participant_finalization)'
            );
            const observedIndexColumns = indexColumns
                .sort((a, b) => Number(a.seqno) - Number(b.seqno))
                .map((row) => row.name);
            if (
                !indexRow
                || indexRow.tbl_name !== RAID_PARTICIPANT_FINALIZATION_INDEX.table
                || observedIndexColumns.length !== RAID_PARTICIPANT_FINALIZATION_INDEX.columns.length
                || observedIndexColumns.some(
                    (column, index) => column !== RAID_PARTICIPANT_FINALIZATION_INDEX.columns[index]
                )
            ) {
                const error = new Error(
                    'Indice de finalizacao existente diverge da forma canonica e exige reconciliacao explicita.'
                );
                error.code = 'raid_finalization_index_mapping_required';
                error.index = RAID_PARTICIPANT_FINALIZATION_INDEX.name;
                error.observedColumns = observedIndexColumns;
                throw error;
            }
        },
    }
);

const RAID_REWARDS_V2_MIGRATION = Object.freeze(
    {
        version: RAID_REWARDS_V2_VERSION,
        key: RAID_REWARDS_V2_KEY,
        description: 'Versiona clover_raid_rewards para o shape V2 completo com PA/PM/box e resource_key, preservando IDs e sem aplicar ou reaplicar recompensas.',
        checksumMaterial: Object.freeze({
            v1TableSql: normalizeRaidRewardsSchemaSql(RAID_REWARDS_V1_TABLE_SQL),
            v2TableSql: normalizeRaidRewardsSchemaSql(RAID_REWARDS_V2_TABLE_SQL),
            rewardTypes: RAID_REWARDS_V2_REWARD_TYPES,
            index: RAID_REWARDS_V2_INDEX,
            sequencePolicy: 'preserve_at_least_historical_sqlite_sequence',
            dependencyPolicy: 'fail_closed_on_unexpected_index_trigger_view_or_inbound_fk',
            revision: 'raid-rewards-v2-table-shape-fail-closed-v1',
        }),
        async up(db) {
            const legacyTemp = await db.get(
                `SELECT name
                 FROM sqlite_schema
                 WHERE type = 'table' AND name = 'clover_raid_rewards_legacy_v1'`
            );
            if (legacyTemp) {
                const error = new Error(
                    'Tabela temporaria legada de rewards ja existe e exige reconciliacao explicita.'
                );
                error.code = 'raid_rewards_v2_schema_mapping_required';
                error.reason = 'legacy_temp_table_present';
                throw error;
            }

            const before = await inspectRaidRewardsSchemaState(db);
            if (before.kind === 'missing') {
                const error = new Error('Tabela obrigatoria ausente para Raid Rewards V2: clover_raid_rewards.');
                error.code = 'migration_precondition_failed';
                error.table = 'clover_raid_rewards';
                throw error;
            }
            if (before.kind === 'unknown') {
                const error = new Error(
                    'Shape de clover_raid_rewards nao corresponde exatamente ao V1 legado nem ao V2 canonico.'
                );
                error.code = 'raid_rewards_v2_schema_mapping_required';
                error.reason = 'table_shape';
                error.observedSql = before.tableSql;
                throw error;
            }

            const unexpectedDependencies = [
                ...before.unexpectedIndexes.map((row) => ({ kind: 'index', name: row.name })),
                ...before.triggers.map((row) => ({ kind: 'trigger', name: row.name })),
                ...before.dependentSchemaObjects.map((row) => ({ kind: row.type, name: row.name })),
                ...before.inboundForeignKeys.map((row) => ({
                    kind: 'inbound_foreign_key',
                    name: row.table + '.' + row.from,
                })),
            ];
            if (unexpectedDependencies.length) {
                const error = new Error(
                    'Rewards possuem dependencias estruturais inesperadas; rebuild automatico foi bloqueado.'
                );
                error.code = 'raid_rewards_v2_dependency_mapping_required';
                error.dependencies = unexpectedDependencies;
                throw error;
            }

            if (!before.indexValid) {
                const error = new Error(
                    'Indice de rewards diverge da forma canonica e exige reconciliacao explicita.'
                );
                error.code = 'raid_rewards_v2_index_mapping_required';
                error.index = RAID_REWARDS_V2_INDEX.name;
                error.observedColumns = before.indexColumns;
                throw error;
            }

            if (before.kind === 'v2') {
                return;
            }

            const invalid = await db.get(
                `SELECT id, target_type, reward_type, amount, status
                 FROM clover_raid_rewards
                 WHERE target_type NOT IN ('general', 'player')
                    OR reward_type NOT IN ('yulls', 'ph', 'stars', 'catalog_item')
                    OR amount <= 0
                    OR status NOT IN ('draft', 'applied', 'cancelled')
                    OR raid_id IS NULL
                    OR label IS NULL
                    OR created_by IS NULL
                 ORDER BY id
                 LIMIT 1`
            );
            if (invalid) {
                const error = new Error(
                    'Reward V1 contem estado que exige reconciliacao explicita antes da migration 0023: id='
                    + invalid.id
                );
                error.code = 'raid_rewards_v2_state_mapping_required';
                error.rewardId = Number(invalid.id);
                error.observed = invalid;
                throw error;
            }

            const countBefore = await db.get(
                'SELECT COUNT(*) AS count, COALESCE(MAX(id), 0) AS max_id FROM clover_raid_rewards'
            );
            const sequenceBefore = await db.get(
                `SELECT seq FROM sqlite_sequence WHERE name = 'clover_raid_rewards'`
            );
            const historicalSequence = sequenceBefore ? Number(sequenceBefore.seq || 0) : null;

            await db.exec('ALTER TABLE clover_raid_rewards RENAME TO clover_raid_rewards_legacy_v1');
            await db.exec(RAID_REWARDS_V2_TABLE_SQL);
            await db.exec(`
                INSERT INTO clover_raid_rewards (
                    id, raid_id, target_type, target_player_id, reward_type, amount,
                    template_key, resource_key, label, reason, status, created_by,
                    created_at, cancelled_at, cancelled_by, metadata_json
                )
                SELECT
                    id, raid_id, target_type, target_player_id, reward_type, amount,
                    template_key, NULL, label, reason, status, created_by,
                    created_at, cancelled_at, cancelled_by, metadata_json
                FROM clover_raid_rewards_legacy_v1
                ORDER BY id
            `);

            const countAfterCopy = await db.get(
                'SELECT COUNT(*) AS count, COALESCE(MAX(id), 0) AS max_id FROM clover_raid_rewards'
            );
            const missingRow = await db.get(`
                SELECT 1 AS found
                FROM (
                    SELECT
                        id, raid_id, target_type, target_player_id, reward_type, amount,
                        template_key, label, reason, status, created_by,
                        created_at, cancelled_at, cancelled_by, metadata_json
                    FROM clover_raid_rewards_legacy_v1
                    EXCEPT
                    SELECT
                        id, raid_id, target_type, target_player_id, reward_type, amount,
                        template_key, label, reason, status, created_by,
                        created_at, cancelled_at, cancelled_by, metadata_json
                    FROM clover_raid_rewards
                )
                LIMIT 1
            `);
            const extraRow = await db.get(`
                SELECT 1 AS found
                FROM (
                    SELECT
                        id, raid_id, target_type, target_player_id, reward_type, amount,
                        template_key, label, reason, status, created_by,
                        created_at, cancelled_at, cancelled_by, metadata_json
                    FROM clover_raid_rewards
                    EXCEPT
                    SELECT
                        id, raid_id, target_type, target_player_id, reward_type, amount,
                        template_key, label, reason, status, created_by,
                        created_at, cancelled_at, cancelled_by, metadata_json
                    FROM clover_raid_rewards_legacy_v1
                )
                LIMIT 1
            `);
            const resourceKeyMutation = await db.get(
                'SELECT id FROM clover_raid_rewards WHERE resource_key IS NOT NULL ORDER BY id LIMIT 1'
            );
            if (
                Number(countAfterCopy.count) !== Number(countBefore.count)
                || Number(countAfterCopy.max_id) !== Number(countBefore.max_id)
                || missingRow
                || extraRow
                || resourceKeyMutation
            ) {
                const error = new Error(
                    'Validacao de copia V1->V2 de rewards falhou; transaction deve reverter integralmente.'
                );
                error.code = 'raid_rewards_v2_copy_validation_failed';
                throw error;
            }

            await db.exec('DROP TABLE clover_raid_rewards_legacy_v1');
            await db.exec(`
                CREATE INDEX idx_clover_raid_rewards_raid
                ON clover_raid_rewards (raid_id, status, id)
            `);

            const sequenceAfterCopy = await db.get(
                `SELECT seq FROM sqlite_sequence WHERE name = 'clover_raid_rewards'`
            );
            const copiedSequence = sequenceAfterCopy ? Number(sequenceAfterCopy.seq || 0) : 0;
            const desiredSequence = Math.max(
                historicalSequence === null ? 0 : historicalSequence,
                copiedSequence,
                Number(countAfterCopy.max_id || 0)
            );
            if (historicalSequence !== null || desiredSequence > 0) {
                const updated = await db.run(
                    `UPDATE sqlite_sequence SET seq = ? WHERE name = 'clover_raid_rewards'`,
                    [desiredSequence]
                );
                if (Number(updated?.changes || 0) === 0) {
                    await db.run(
                        `INSERT INTO sqlite_sequence (name, seq) VALUES ('clover_raid_rewards', ?)`,
                        [desiredSequence]
                    );
                }
            }

            const after = await inspectRaidRewardsSchemaState(db);
            if (after.kind !== 'v2') {
                const error = new Error('Shape V2 de rewards nao foi produzido exatamente.');
                error.code = 'raid_rewards_v2_schema_mapping_required';
                error.reason = 'post_migration_shape';
                error.observedSql = after.tableSql;
                throw error;
            }
            if (
                after.unexpectedIndexes.length
                || after.triggers.length
                || after.dependentSchemaObjects.length
                || after.inboundForeignKeys.length
            ) {
                const error = new Error('Dependencias inesperadas surgiram apos rebuild de rewards.');
                error.code = 'raid_rewards_v2_dependency_mapping_required';
                throw error;
            }
            if (!after.indexValid) {
                const error = new Error('Indice canonico de rewards nao foi produzido exatamente.');
                error.code = 'raid_rewards_v2_index_mapping_required';
                error.index = RAID_REWARDS_V2_INDEX.name;
                error.observedColumns = after.indexColumns;
                throw error;
            }
        },
    }
);

const RAID_MONTHLY_PROGRESS_MIGRATION = Object.freeze(
    {
        version: RAID_MONTHLY_PROGRESS_VERSION,
        key: RAID_MONTHLY_PROGRESS_KEY,
        description: 'Versiona as duas tabelas e quatro indices de progresso mensal de Raid de forma estritamente nao retroativa, sem sintetizar reservas ou creditos historicos.',
        checksumMaterial: Object.freeze({
            reservationsTableSql: normalizeRaidMonthlySchemaSql(RAID_MONTHLY_RESERVATIONS_TABLE_SQL),
            ledgerTableSql: normalizeRaidMonthlySchemaSql(RAID_MONTHLY_LEDGER_TABLE_SQL),
            indexes: RAID_MONTHLY_PROGRESS_INDEXES.map((entry) => Object.freeze({
                name: entry.name,
                table: entry.table,
                sql: normalizeRaidMonthlySchemaSql(entry.sql),
            })),
            deploymentPolicy: 'strictly_non_retroactive_no_history_synthesis',
            partialStatePolicy: 'fail_closed_no_silent_repair',
            revision: 'raid-monthly-progress-table-shape-fail-closed-v1',
        }),
        async up(db) {
            const before = await inspectRaidMonthlyProgressSchemaState(db);

            if (before.kind === 'partial' || before.kind === 'unknown') {
                const error = new Error(
                    'Schema mensal de Raid parcial ou incompativel exige reconciliacao explicita antes da migration 0024.'
                );
                error.code = 'raid_monthly_schema_mapping_required';
                error.reason = before.kind === 'partial' ? 'partial_tables' : 'table_shape';
                error.tables = before.tables;
                throw error;
            }

            if (before.kind === 'missing') {
                const conflictingIndexes = before.indexes.filter((entry) => entry.exists);
                if (conflictingIndexes.length) {
                    const error = new Error(
                        'Nome de indice mensal canonico ja existe fora do shape esperado e exige reconciliacao explicita.'
                    );
                    error.code = 'raid_monthly_index_mapping_required';
                    error.indexes = conflictingIndexes;
                    throw error;
                }

                await db.exec(RAID_MONTHLY_RESERVATIONS_TABLE_SQL);
                await db.exec(RAID_MONTHLY_LEDGER_TABLE_SQL);
                for (const index of RAID_MONTHLY_PROGRESS_INDEXES) {
                    await db.exec(index.sql);
                }

                const reservationCount = await db.get(
                    'SELECT COUNT(*) AS count FROM clover_raid_monthly_reservations'
                );
                const ledgerCount = await db.get(
                    'SELECT COUNT(*) AS count FROM clover_raid_monthly_ledger'
                );
                if (Number(reservationCount?.count || 0) !== 0 || Number(ledgerCount?.count || 0) !== 0) {
                    const error = new Error(
                        'Migration 0024 nao pode sintetizar progresso mensal historico.'
                    );
                    error.code = 'raid_monthly_non_retroactive_invariant_failed';
                    throw error;
                }

                const after = await inspectRaidMonthlyProgressSchemaState(db);
                if (after.kind !== 'exact') {
                    const error = new Error('Migration 0024 nao produziu o table-shape mensal canonico.');
                    error.code = 'raid_monthly_schema_mapping_required';
                    error.reason = 'post_create_shape';
                    error.tables = after.tables;
                    throw error;
                }
                if (!after.indexValid) {
                    const error = new Error('Migration 0024 nao produziu os quatro indices mensais canonicos.');
                    error.code = 'raid_monthly_index_mapping_required';
                    error.indexes = after.indexes.filter((entry) => !entry.valid);
                    throw error;
                }
                return;
            }

            await assertRaidMonthlyStoredStateCompatible(db);

            if (!before.indexValid) {
                const error = new Error(
                    'Indice mensal ausente ou divergente exige reconciliacao explicita; a migration 0024 nao repara shape preexistente.'
                );
                error.code = 'raid_monthly_index_mapping_required';
                error.indexes = before.indexes.filter((entry) => !entry.valid);
                throw error;
            }
        },
    }
);

const RAID_SUPPORT_TABLES = Object.freeze([
    Object.freeze({
        name: 'clover_raid_hosts',
        sql: `
CREATE TABLE clover_raid_hosts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raid_id INTEGER NOT NULL,
    player_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'co_host')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    assigned_by TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    revoked_at TEXT DEFAULT NULL,
    revoked_by TEXT DEFAULT NULL,
    metadata_json TEXT DEFAULT NULL
)
`,
    }),
    Object.freeze({
        name: 'clover_raid_loadout_items',
        sql: `
CREATE TABLE clover_raid_loadout_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raid_id INTEGER NOT NULL,
    participant_id INTEGER NOT NULL,
    player_id TEXT NOT NULL,
    inventory_item_id INTEGER NOT NULL,
    reservation_id INTEGER NOT NULL,
    slot_key TEXT NOT NULL
        CHECK (slot_key IN ('body', 'main_hand', 'off_hand', 'quick_1', 'quick_2', 'aerial_transport')),
    quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
    quantity_consumed INTEGER NOT NULL DEFAULT 0 CHECK (quantity_consumed >= 0),
    durability_start INTEGER DEFAULT NULL,
    durability_current INTEGER DEFAULT NULL,
    snapshot_json TEXT DEFAULT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    metadata_json TEXT DEFAULT NULL,
    UNIQUE (raid_id, participant_id, slot_key),
    UNIQUE (raid_id, participant_id, inventory_item_id)
)
`,
    }),
    Object.freeze({
        name: 'clover_raid_item_events',
        sql: `
CREATE TABLE clover_raid_item_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raid_id INTEGER NOT NULL,
    participant_id INTEGER NOT NULL,
    loadout_item_id INTEGER NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('durability_loss', 'consumed', 'condition')),
    amount INTEGER NOT NULL DEFAULT 0,
    cause TEXT NOT NULL,
    before_json TEXT DEFAULT NULL,
    after_json TEXT DEFAULT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    idempotency_key TEXT DEFAULT NULL UNIQUE,
    metadata_json TEXT DEFAULT NULL
)
`,
    }),
    Object.freeze({
        name: 'clover_raid_conditions',
        sql: `
CREATE TABLE clover_raid_conditions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raid_id INTEGER NOT NULL,
    target_type TEXT NOT NULL CHECK (target_type IN ('general', 'player')),
    participant_id INTEGER DEFAULT NULL,
    target_player_id TEXT DEFAULT NULL,
    condition_key TEXT NOT NULL,
    label TEXT NOT NULL,
    description TEXT DEFAULT NULL,
    severity TEXT NOT NULL DEFAULT 'normal'
        CHECK (severity IN ('leve', 'normal', 'seria', 'critica')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'resolved')),
    applied_by TEXT NOT NULL,
    applied_at TEXT DEFAULT CURRENT_TIMESTAMP,
    resolved_by TEXT DEFAULT NULL,
    resolved_at TEXT DEFAULT NULL,
    resolution_note TEXT DEFAULT NULL,
    metadata_json TEXT DEFAULT NULL
)
`,
    }),
    Object.freeze({
        name: 'clover_raid_reward_deliveries',
        sql: `
CREATE TABLE clover_raid_reward_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raid_id INTEGER NOT NULL,
    reward_id INTEGER NOT NULL,
    player_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'reversed')),
    result_json TEXT DEFAULT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    metadata_json TEXT DEFAULT NULL,
    UNIQUE (reward_id, player_id)
)
`,
    }),
    Object.freeze({
        name: 'clover_raid_events',
        sql: `
CREATE TABLE clover_raid_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raid_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    subject_player_id TEXT DEFAULT NULL,
    before_json TEXT DEFAULT NULL,
    after_json TEXT DEFAULT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    idempotency_key TEXT DEFAULT NULL UNIQUE,
    metadata_json TEXT DEFAULT NULL
)
`,
    }),
]);

const RAID_SUPPORT_INDEXES = Object.freeze([
    Object.freeze({
        name: 'idx_clover_raid_hosts_active',
        table: 'clover_raid_hosts',
        sql: `
CREATE UNIQUE INDEX idx_clover_raid_hosts_active
ON clover_raid_hosts (raid_id, player_id)
WHERE status = 'active'
`,
    }),
    Object.freeze({
        name: 'idx_clover_raid_loadout_participant',
        table: 'clover_raid_loadout_items',
        sql: `
CREATE INDEX idx_clover_raid_loadout_participant
ON clover_raid_loadout_items (participant_id, slot_key, id)
`,
    }),
    Object.freeze({
        name: 'idx_clover_raid_item_events_raid',
        table: 'clover_raid_item_events',
        sql: `
CREATE INDEX idx_clover_raid_item_events_raid
ON clover_raid_item_events (raid_id, created_at DESC, id DESC)
`,
    }),
    Object.freeze({
        name: 'idx_clover_raid_conditions_raid',
        table: 'clover_raid_conditions',
        sql: `
CREATE INDEX idx_clover_raid_conditions_raid
ON clover_raid_conditions (raid_id, status, applied_at DESC, id DESC)
`,
    }),
    Object.freeze({
        name: 'idx_clover_raid_reward_deliveries_player',
        table: 'clover_raid_reward_deliveries',
        sql: `
CREATE INDEX idx_clover_raid_reward_deliveries_player
ON clover_raid_reward_deliveries (player_id, created_at DESC, id DESC)
`,
    }),
    Object.freeze({
        name: 'idx_clover_raid_events_raid',
        table: 'clover_raid_events',
        sql: `
CREATE INDEX idx_clover_raid_events_raid
ON clover_raid_events (raid_id, created_at DESC, id DESC)
`,
    }),
]);

function normalizeRaidSupportSchemaSql(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

async function inspectRaidSupportSchemaState(db) {
    const tables = [];
    for (const spec of RAID_SUPPORT_TABLES) {
        const row = await db.get(
            `SELECT name, sql FROM sqlite_schema WHERE type='table' AND name=?`,
            [spec.name]
        );
        const exists = Boolean(row);
        const exact = exists
            && normalizeRaidSupportSchemaSql(row.sql) === normalizeRaidSupportSchemaSql(spec.sql);
        tables.push(Object.freeze({
            name: spec.name,
            exists,
            exact,
            observedSql: row?.sql || null,
        }));
    }

    const existingTables = tables.filter((entry) => entry.exists).length;
    let kind = 'absent';
    if (existingTables > 0 && existingTables < RAID_SUPPORT_TABLES.length) {
        kind = 'partial';
    } else if (existingTables === RAID_SUPPORT_TABLES.length) {
        kind = tables.every((entry) => entry.exact) ? 'exact' : 'unknown';
    }

    const indexes = [];
    for (const spec of RAID_SUPPORT_INDEXES) {
        const row = await db.get(
            `SELECT name, tbl_name AS table_name, sql
             FROM sqlite_schema
             WHERE type='index' AND name=?`,
            [spec.name]
        );
        const exists = Boolean(row);
        const exact = exists
            && row.table_name === spec.table
            && normalizeRaidSupportSchemaSql(row.sql) === normalizeRaidSupportSchemaSql(spec.sql);
        indexes.push(Object.freeze({
            name: spec.name,
            table: spec.table,
            exists,
            exact,
            observedTable: row?.table_name || null,
            observedSql: row?.sql || null,
        }));
    }

    const indexValid = kind === 'absent'
        ? indexes.every((entry) => !entry.exists)
        : kind === 'exact'
            ? indexes.every((entry) => entry.exact)
            : false;

    return Object.freeze({
        kind,
        exact: kind === 'exact' && indexValid,
        indexValid,
        tables: Object.freeze(tables),
        indexes: Object.freeze(indexes),
    });
}

async function inspectRaidSupportStoredState(db) {
    const checks = [
        Object.freeze({
            table: 'clover_raid_hosts',
            sql: `SELECT id FROM clover_raid_hosts
                  WHERE role NOT IN ('owner', 'co_host')
                     OR status NOT IN ('active', 'revoked')
                  LIMIT 1`,
        }),
        Object.freeze({
            table: 'clover_raid_loadout_items',
            sql: `SELECT id FROM clover_raid_loadout_items
                  WHERE slot_key NOT IN ('body', 'main_hand', 'off_hand', 'quick_1', 'quick_2', 'aerial_transport')
                     OR quantity <= 0
                     OR quantity_consumed < 0
                  LIMIT 1`,
        }),
        Object.freeze({
            table: 'clover_raid_item_events',
            sql: `SELECT id FROM clover_raid_item_events
                  WHERE event_type NOT IN ('durability_loss', 'consumed', 'condition')
                  LIMIT 1`,
        }),
        Object.freeze({
            table: 'clover_raid_conditions',
            sql: `SELECT id FROM clover_raid_conditions
                  WHERE target_type NOT IN ('general', 'player')
                     OR severity NOT IN ('leve', 'normal', 'seria', 'critica')
                     OR status NOT IN ('active', 'resolved')
                  LIMIT 1`,
        }),
        Object.freeze({
            table: 'clover_raid_reward_deliveries',
            sql: `SELECT id FROM clover_raid_reward_deliveries
                  WHERE status NOT IN ('completed', 'reversed')
                  LIMIT 1`,
        }),
    ];

    for (const check of checks) {
        const row = await db.get(check.sql);
        if (row) {
            return Object.freeze({ table: check.table, rowId: row.id });
        }
    }
    return null;
}

const RAID_SUPPORT_TABLES_MIGRATION = Object.freeze(
    {
        version: RAID_SUPPORT_TABLES_VERSION,
        key: RAID_SUPPORT_TABLES_KEY,
        description: 'Formaliza as seis tabelas auxiliares e seis indices de Raid que ainda eram criados pelo legacy, sem backfill, reescrita ou alteracao retroativa de dados.',
        checksumMaterial: Object.freeze({
            tables: RAID_SUPPORT_TABLES.map((entry) => Object.freeze({
                name: entry.name,
                sql: normalizeRaidSupportSchemaSql(entry.sql),
            })),
            indexes: RAID_SUPPORT_INDEXES.map((entry) => Object.freeze({
                name: entry.name,
                table: entry.table,
                sql: normalizeRaidSupportSchemaSql(entry.sql),
            })),
            revision: 'raid-support-tables-fail-closed-v1',
        }),
        async up(db) {
            const before = await inspectRaidSupportSchemaState(db);

            if (before.kind === 'partial' || before.kind === 'unknown') {
                const error = new Error(
                    'Schema auxiliar de Raid parcial ou incompativel exige reconciliacao explicita antes da migration 0025.'
                );
                error.code = 'raid_support_schema_mapping_required';
                error.reason = before.kind === 'partial' ? 'partial_tables' : 'table_shape';
                error.tables = before.tables;
                throw error;
            }

            if (!before.indexValid) {
                const error = new Error(
                    'Indices canonicos do schema auxiliar de Raid estao ausentes, divergentes ou ocupados por outro objeto.'
                );
                error.code = 'raid_support_index_mapping_required';
                error.indexes = before.indexes.filter((entry) => !entry.exact);
                throw error;
            }

            if (before.kind === 'absent') {
                for (const table of RAID_SUPPORT_TABLES) {
                    await db.exec(table.sql);
                }
                for (const index of RAID_SUPPORT_INDEXES) {
                    await db.exec(index.sql);
                }
            }

            const after = await inspectRaidSupportSchemaState(db);
            if (after.kind !== 'exact') {
                const error = new Error('Migration 0025 nao produziu o table-shape auxiliar de Raid canonico.');
                error.code = 'raid_support_schema_mapping_required';
                error.reason = 'post_create_shape';
                error.tables = after.tables;
                throw error;
            }
            if (!after.indexValid) {
                const error = new Error('Migration 0025 nao produziu os indices auxiliares de Raid canonicos.');
                error.code = 'raid_support_index_mapping_required';
                error.indexes = after.indexes.filter((entry) => !entry.exact);
                throw error;
            }

            const invalidState = await inspectRaidSupportStoredState(db);
            if (invalidState) {
                const error = new Error(
                    `Estado armazenado invalido em ${invalidState.table} impede formalizacao automatica da migration 0025.`
                );
                error.code = 'raid_support_state_mapping_required';
                error.table = invalidState.table;
                error.rowId = invalidState.rowId;
                throw error;
            }
        },
    }
);

const RAID_IDEMPOTENCY_REQUESTS_TABLES = Object.freeze([
    Object.freeze({
        name: 'clover_raid_creation_requests',
        sql: `
CREATE TABLE clover_raid_creation_requests (
    idempotency_key TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'completed')),
    processing_token TEXT DEFAULT NULL,
    lease_expires_at TEXT DEFAULT NULL,
    raid_id INTEGER DEFAULT NULL,
    result_json TEXT DEFAULT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT DEFAULT NULL
)
`,
    }),
    Object.freeze({
        name: 'clover_raid_mutation_requests',
        sql: `
CREATE TABLE clover_raid_mutation_requests (
    idempotency_key TEXT PRIMARY KEY,
    operation TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    raid_id INTEGER NOT NULL,
    subject_player_id TEXT DEFAULT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'completed')),
    processing_token TEXT DEFAULT NULL,
    lease_expires_at TEXT DEFAULT NULL,
    result_json TEXT DEFAULT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT DEFAULT NULL
)
`,
    }),
]);

const RAID_IDEMPOTENCY_REQUESTS_INDEXES = Object.freeze([
    Object.freeze({
        name: 'idx_clover_raid_creation_status',
        table: 'clover_raid_creation_requests',
        sql: `
CREATE INDEX idx_clover_raid_creation_status
ON clover_raid_creation_requests (status, lease_expires_at, updated_at)
`,
    }),
    Object.freeze({
        name: 'idx_clover_raid_mutation_requests_status',
        table: 'clover_raid_mutation_requests',
        sql: `
CREATE INDEX idx_clover_raid_mutation_requests_status
ON clover_raid_mutation_requests (status, lease_expires_at, updated_at)
`,
    }),
]);

function normalizeRaidIdempotencyRequestsSchemaSql(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

async function inspectRaidIdempotencyRequestsSchemaState(db) {
    const tables = [];
    for (const spec of RAID_IDEMPOTENCY_REQUESTS_TABLES) {
        const row = await db.get(
            `SELECT name, sql FROM sqlite_schema WHERE type='table' AND name=?`,
            [spec.name]
        );
        const exists = Boolean(row);
        tables.push(Object.freeze({
            name: spec.name,
            exists,
            exact: exists
                && normalizeRaidIdempotencyRequestsSchemaSql(row.sql)
                    === normalizeRaidIdempotencyRequestsSchemaSql(spec.sql),
            observedSql: row?.sql || null,
        }));
    }

    const existingTables = tables.filter((entry) => entry.exists).length;
    let kind = 'absent';
    if (existingTables > 0 && existingTables < RAID_IDEMPOTENCY_REQUESTS_TABLES.length) {
        kind = 'partial';
    } else if (existingTables === RAID_IDEMPOTENCY_REQUESTS_TABLES.length) {
        kind = tables.every((entry) => entry.exact) ? 'exact' : 'unknown';
    }

    const indexes = [];
    for (const spec of RAID_IDEMPOTENCY_REQUESTS_INDEXES) {
        const row = await db.get(
            `SELECT type, name, tbl_name AS table_name, sql FROM sqlite_schema WHERE name=?`,
            [spec.name]
        );
        const exists = Boolean(row);
        indexes.push(Object.freeze({
            name: spec.name,
            table: spec.table,
            exists,
            exact: exists
                && row.type === 'index'
                && row.table_name === spec.table
                && normalizeRaidIdempotencyRequestsSchemaSql(row.sql)
                    === normalizeRaidIdempotencyRequestsSchemaSql(spec.sql),
            observedType: row?.type || null,
            observedTable: row?.table_name || null,
            observedSql: row?.sql || null,
        }));
    }

    const indexValid = kind === 'absent'
        ? indexes.every((entry) => !entry.exists)
        : kind === 'exact'
            ? indexes.every((entry) => entry.exact)
            : false;

    return Object.freeze({
        kind,
        exact: kind === 'exact' && indexValid,
        indexValid,
        tables: Object.freeze(tables),
        indexes: Object.freeze(indexes),
    });
}

async function inspectRaidIdempotencyRequestsStoredState(db) {
    for (const table of RAID_IDEMPOTENCY_REQUESTS_TABLES) {
        const row = await db.get(
            `SELECT idempotency_key, status FROM ${table.name}
             WHERE status NOT IN ('pending', 'processing', 'completed') LIMIT 1`
        );
        if (row) {
            return Object.freeze({
                table: table.name,
                idempotencyKey: row.idempotency_key,
                status: row.status,
            });
        }
    }
    return null;
}

const RAID_IDEMPOTENCY_REQUESTS_MIGRATION = Object.freeze(
    {
        version: RAID_IDEMPOTENCY_REQUESTS_VERSION,
        key: RAID_IDEMPOTENCY_REQUESTS_KEY,
        description: 'Formaliza as duas tabelas de requests de idempotencia de Raid sem backfill, replay ou efeitos retroativos.',
        checksumMaterial: Object.freeze({
            tables: RAID_IDEMPOTENCY_REQUESTS_TABLES.map((entry) => Object.freeze({
                name: entry.name,
                sql: normalizeRaidIdempotencyRequestsSchemaSql(entry.sql),
            })),
            indexes: RAID_IDEMPOTENCY_REQUESTS_INDEXES.map((entry) => Object.freeze({
                name: entry.name,
                table: entry.table,
                sql: normalizeRaidIdempotencyRequestsSchemaSql(entry.sql),
            })),
            allowedStatuses: Object.freeze(['pending', 'processing', 'completed']),
            revision: 'raid-idempotency-requests-fail-closed-v1',
        }),
        async up(db) {
            const before = await inspectRaidIdempotencyRequestsSchemaState(db);
            if (before.kind === 'partial' || before.kind === 'unknown') {
                const error = new Error(
                    'Schema de requests de idempotencia de Raid parcial ou incompativel exige reconciliacao explicita antes da migration 0026.'
                );
                error.code = 'raid_idempotency_requests_schema_mapping_required';
                error.reason = before.kind === 'partial' ? 'partial_tables' : 'table_shape';
                error.tables = before.tables;
                throw error;
            }
            if (!before.indexValid) {
                const error = new Error(
                    'Indices canonicos de requests de idempotencia de Raid estao ausentes, divergentes ou ocupados por outro objeto.'
                );
                error.code = 'raid_idempotency_requests_index_mapping_required';
                error.indexes = before.indexes.filter((entry) => !entry.exact);
                throw error;
            }
            if (before.kind === 'absent') {
                for (const table of RAID_IDEMPOTENCY_REQUESTS_TABLES) {
                    await db.exec(table.sql);
                }
                for (const index of RAID_IDEMPOTENCY_REQUESTS_INDEXES) {
                    await db.exec(index.sql);
                }
            }

            const after = await inspectRaidIdempotencyRequestsSchemaState(db);
            if (after.kind !== 'exact') {
                const error = new Error('Migration 0026 nao produziu o table-shape canonico de requests de idempotencia de Raid.');
                error.code = 'raid_idempotency_requests_schema_mapping_required';
                error.reason = 'post_create_shape';
                error.tables = after.tables;
                throw error;
            }
            if (!after.indexValid) {
                const error = new Error('Migration 0026 nao produziu os indices canonicos de requests de idempotencia de Raid.');
                error.code = 'raid_idempotency_requests_index_mapping_required';
                error.indexes = after.indexes.filter((entry) => !entry.exact);
                throw error;
            }

            const invalidState = await inspectRaidIdempotencyRequestsStoredState(db);
            if (invalidState) {
                const error = new Error(
                    `Estado armazenado invalido em ${invalidState.table} impede formalizacao automatica da migration 0026.`
                );
                error.code = 'raid_idempotency_requests_state_mapping_required';
                error.table = invalidState.table;
                error.idempotencyKey = invalidState.idempotencyKey;
                error.status = invalidState.status;
                throw error;
            }
        },
    }
);

function normalizeRaidRewardProposalSchemaSql(value) {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .replace(/\s*([(),])\s*/g, '$1')
        .trim().replace(/;$/, '').trim();
}

const RAID_REWARD_PROPOSAL_BASE_OBJECTS = Object.freeze([
    Object.freeze({
        type: 'table',
        name: 'clover_raid_reward_proposals',
        sql: `
CREATE TABLE clover_raid_reward_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raid_id INTEGER NOT NULL,
    proposed_by TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'returned', 'approved', 'rejected', 'delivered')),
    proposed_at TEXT DEFAULT CURRENT_TIMESTAMP,
    reviewed_by TEXT DEFAULT NULL,
    reviewed_at TEXT DEFAULT NULL,
    review_note TEXT DEFAULT NULL,
    delivery_key TEXT DEFAULT NULL UNIQUE,
    delivery_result_json TEXT DEFAULT NULL,
    snapshot_json TEXT DEFAULT NULL,
    snapshot_hash TEXT DEFAULT NULL,
    snapshot_version INTEGER NOT NULL DEFAULT 1,
    metadata_json TEXT DEFAULT NULL
)
`,
    }),
    Object.freeze({
        type: 'index',
        name: 'idx_clover_raid_reward_proposals_open',
        table: 'clover_raid_reward_proposals',
        sql: `
CREATE UNIQUE INDEX idx_clover_raid_reward_proposals_open
ON clover_raid_reward_proposals (raid_id)
WHERE status IN ('pending', 'returned')
`,
    }),
    Object.freeze({
        type: 'index',
        name: 'idx_clover_raid_reward_proposals_status',
        table: 'clover_raid_reward_proposals',
        sql: `
CREATE INDEX idx_clover_raid_reward_proposals_status
ON clover_raid_reward_proposals (status, proposed_at ASC, id ASC)
`,
    }),
]);

const RAID_REWARD_PROPOSAL_IDEMPOTENCY_OBJECTS = Object.freeze([
    Object.freeze({
        type: 'table',
        name: 'clover_raid_reward_review_intents',
        sql: `
CREATE TABLE clover_raid_reward_review_intents (
    idempotency_key TEXT PRIMARY KEY,
    proposal_id INTEGER NOT NULL,
    raid_id INTEGER NOT NULL,
    actor_id TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('approve', 'return', 'reject')),
    review_note TEXT DEFAULT NULL,
    fingerprint TEXT NOT NULL,
    expected_snapshot_hash TEXT DEFAULT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'completed')),
    processing_token TEXT DEFAULT NULL,
    lease_expires_at TEXT DEFAULT NULL,
    result_json TEXT DEFAULT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT DEFAULT NULL,
    FOREIGN KEY (proposal_id) REFERENCES clover_raid_reward_proposals(id)
)
`,
    }),
    Object.freeze({
        type: 'index',
        name: 'idx_clover_raid_reward_review_intents_proposal',
        table: 'clover_raid_reward_review_intents',
        sql: `
CREATE INDEX idx_clover_raid_reward_review_intents_proposal
ON clover_raid_reward_review_intents (proposal_id, status, updated_at)
`,
    }),
    Object.freeze({
        type: 'table',
        name: 'clover_raid_reward_review_events',
        sql: `
CREATE TABLE clover_raid_reward_review_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    idempotency_key TEXT NOT NULL UNIQUE,
    proposal_id INTEGER NOT NULL,
    raid_id INTEGER NOT NULL,
    actor_id TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('approve', 'return', 'reject')),
    proposal_status TEXT NOT NULL,
    review_note TEXT DEFAULT NULL,
    fingerprint TEXT NOT NULL,
    delivery_key TEXT DEFAULT NULL,
    delivery_result_json TEXT DEFAULT NULL,
    reviewed_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (proposal_id) REFERENCES clover_raid_reward_proposals(id)
)
`,
    }),
    Object.freeze({
        type: 'index',
        name: 'idx_clover_raid_reward_review_events_proposal',
        table: 'clover_raid_reward_review_events',
        sql: `
CREATE INDEX idx_clover_raid_reward_review_events_proposal
ON clover_raid_reward_review_events (proposal_id, reviewed_at, id)
`,
    }),
    Object.freeze({
        type: 'trigger',
        name: 'trg_clover_raid_reward_review_capture',
        table: 'clover_raid_reward_proposals',
        sql: `
CREATE TRIGGER trg_clover_raid_reward_review_capture
AFTER UPDATE OF status, reviewed_by ON clover_raid_reward_proposals
WHEN OLD.status = 'pending'
     AND NEW.status IN ('returned', 'rejected', 'delivered')
     AND NEW.reviewed_by IS NOT NULL
     AND TRIM(NEW.reviewed_by) <> ''
BEGIN
    INSERT OR IGNORE INTO clover_raid_reward_review_events
    (idempotency_key, proposal_id, raid_id, actor_id, decision,
     proposal_status, review_note, fingerprint, delivery_key,
     delivery_result_json, reviewed_at)
    SELECT
        intent.idempotency_key,
        NEW.id,
        intent.raid_id,
        NEW.reviewed_by,
        intent.decision,
        NEW.status,
        NEW.review_note,
        intent.fingerprint,
        NEW.delivery_key,
        NEW.delivery_result_json,
        COALESCE(NEW.reviewed_at, CURRENT_TIMESTAMP)
    FROM clover_raid_reward_review_intents intent
    WHERE intent.proposal_id = NEW.id
      AND intent.actor_id = NEW.reviewed_by
      AND intent.status = 'processing'
      AND intent.decision = CASE NEW.status
          WHEN 'delivered' THEN 'approve'
          WHEN 'returned' THEN 'return'
          ELSE 'reject'
      END
    ORDER BY intent.updated_at DESC
    LIMIT 1;
END
`,
    }),
    Object.freeze({
        type: 'trigger',
        name: 'trg_clover_raid_reward_review_event_update_block',
        table: 'clover_raid_reward_review_events',
        sql: `
CREATE TRIGGER trg_clover_raid_reward_review_event_update_block
BEFORE UPDATE ON clover_raid_reward_review_events
BEGIN
    SELECT RAISE(ABORT, 'raid_reward_review_event_immutable');
END
`,
    }),
    Object.freeze({
        type: 'trigger',
        name: 'trg_clover_raid_reward_review_event_delete_block',
        table: 'clover_raid_reward_review_events',
        sql: `
CREATE TRIGGER trg_clover_raid_reward_review_event_delete_block
BEFORE DELETE ON clover_raid_reward_review_events
BEGIN
    SELECT RAISE(ABORT, 'raid_reward_review_event_immutable');
END
`,
    }),
    Object.freeze({
        type: 'trigger',
        name: 'trg_clover_raid_reward_review_context_guard',
        table: 'clover_raid_reward_proposals',
        sql: `
CREATE TRIGGER trg_clover_raid_reward_review_context_guard
BEFORE UPDATE OF status, reviewed_by ON clover_raid_reward_proposals
WHEN OLD.status = 'pending'
     AND NEW.status IN ('returned', 'rejected', 'delivered')
     AND NEW.reviewed_by IS NOT NULL
     AND TRIM(NEW.reviewed_by) <> ''
     AND EXISTS (
         SELECT 1
         FROM clover_raid_reward_review_intents pending_intent
         WHERE pending_intent.proposal_id = NEW.id
           AND pending_intent.actor_id = NEW.reviewed_by
           AND pending_intent.status = 'processing'
     )
     AND NOT EXISTS (
         SELECT 1
         FROM clover_raid_reward_review_intents intent
         WHERE intent.idempotency_key = (
             SELECT latest.idempotency_key
             FROM clover_raid_reward_review_intents latest
             WHERE latest.proposal_id = NEW.id
               AND latest.actor_id = NEW.reviewed_by
               AND latest.status = 'processing'
             ORDER BY latest.updated_at DESC, latest.idempotency_key DESC
             LIMIT 1
         )
           AND intent.decision = CASE NEW.status
               WHEN 'delivered' THEN 'approve'
               WHEN 'returned' THEN 'return'
               ELSE 'reject'
           END
           AND COALESCE(intent.review_note, '') = COALESCE(NEW.review_note, '')
           AND COALESCE(intent.expected_snapshot_hash, '') = COALESCE(OLD.snapshot_hash, '')
     )
BEGIN
    SELECT RAISE(ABORT, 'raid_reward_review_context_mismatch');
END
`,
    }),
]);

async function inspectRaidRewardProposalObjects(db, objects) {
    const observed = [];
    for (const spec of objects) {
        const row = await db.get(
            `SELECT type, name, tbl_name AS table_name, sql
             FROM sqlite_schema WHERE name = ?`,
            [spec.name]
        );
        const exists = Boolean(row);
        observed.push(Object.freeze({
            name: spec.name,
            type: spec.type,
            table: spec.table || null,
            exists,
            exact: exists
                && row.type === spec.type
                && (!spec.table || row.table_name === spec.table)
                && normalizeRaidRewardProposalSchemaSql(row.sql)
                    === normalizeRaidRewardProposalSchemaSql(spec.sql),
            observedType: row?.type || null,
            observedTable: row?.table_name || null,
            observedSql: row?.sql || null,
        }));
    }
    const count = observed.filter((entry) => entry.exists).length;
    return Object.freeze({
        kind: count === 0 ? 'absent' : count === observed.length && observed.every((entry) => entry.exact) ? 'exact' : count === observed.length ? 'unknown' : 'partial',
        exact: count === observed.length && observed.every((entry) => entry.exact),
        objects: Object.freeze(observed),
    });
}

async function createRaidRewardProposalObjects(db, objects) {
    for (const spec of objects) await db.exec(spec.sql);
}

function raidRewardProposalLegacyTableSql(snapshotColumns = []) {
    return `
CREATE TABLE clover_raid_reward_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raid_id INTEGER NOT NULL,
    proposed_by TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'returned', 'approved', 'rejected', 'delivered')),
    proposed_at TEXT DEFAULT CURRENT_TIMESTAMP,
    reviewed_by TEXT DEFAULT NULL,
    reviewed_at TEXT DEFAULT NULL,
    review_note TEXT DEFAULT NULL,
    delivery_key TEXT DEFAULT NULL UNIQUE,
    delivery_result_json TEXT DEFAULT NULL,
    metadata_json TEXT DEFAULT NULL${snapshotColumns.length ? `,\n    ${snapshotColumns.join(',\n    ')}` : ''}
)
`;
}

const RAID_REWARD_PROPOSAL_LEGACY_BASE_TABLES = Object.freeze([
    Object.freeze({
        lineage: 'pre_snapshot_exact',
        snapshotColumns: Object.freeze([]),
        sql: raidRewardProposalLegacyTableSql(),
    }),
    Object.freeze({
        lineage: 'snapshot_json_prefix_exact',
        snapshotColumns: Object.freeze(['snapshot_json TEXT DEFAULT NULL']),
        sql: raidRewardProposalLegacyTableSql(['snapshot_json TEXT DEFAULT NULL']),
    }),
    Object.freeze({
        lineage: 'snapshot_json_hash_prefix_exact',
        snapshotColumns: Object.freeze(['snapshot_json TEXT DEFAULT NULL', 'snapshot_hash TEXT DEFAULT NULL']),
        sql: raidRewardProposalLegacyTableSql(['snapshot_json TEXT DEFAULT NULL', 'snapshot_hash TEXT DEFAULT NULL']),
    }),
    Object.freeze({
        lineage: 'snapshot_columns_prefix_exact',
        snapshotColumns: Object.freeze([
            'snapshot_json TEXT DEFAULT NULL',
            'snapshot_hash TEXT DEFAULT NULL',
            'snapshot_version INTEGER NOT NULL DEFAULT 1',
        ]),
        sql: raidRewardProposalLegacyTableSql([
            'snapshot_json TEXT DEFAULT NULL',
            'snapshot_hash TEXT DEFAULT NULL',
            'snapshot_version INTEGER NOT NULL DEFAULT 1',
        ]),
    }),
]);

async function inspectRaidRewardProposalBaseSchemaState(db) {
    const table = await db.get(`SELECT type, name, sql FROM sqlite_schema WHERE name = 'clover_raid_reward_proposals'`);
    const indexes = await inspectRaidRewardProposalObjects(
        db,
        RAID_REWARD_PROPOSAL_BASE_OBJECTS.filter((entry) => entry.type === 'index')
    );
    const expectedCurrent = RAID_REWARD_PROPOSAL_BASE_OBJECTS[0];
    const normalized = normalizeRaidRewardProposalSchemaSql(table?.sql);
    const current = table?.type === 'table'
        && normalized === normalizeRaidRewardProposalSchemaSql(expectedCurrent.sql);
    const legacy = RAID_REWARD_PROPOSAL_LEGACY_BASE_TABLES.find((entry) => (
        table?.type === 'table' && normalized === normalizeRaidRewardProposalSchemaSql(entry.sql)
    ));
    const objectCount = Number(Boolean(table)) + indexes.objects.filter((entry) => entry.exists).length;
    if (objectCount === 0) return Object.freeze({ kind: 'absent', lineage: 'family_absent_fresh', table, indexes });
    if (!indexes.exact || (!current && !legacy)) {
        return Object.freeze({ kind: objectCount === 3 ? 'unknown' : 'partial', lineage: null, table, indexes });
    }
    if (current) return Object.freeze({ kind: 'exact', lineage: 'current_proposal_pre_governance', table, indexes });
    return Object.freeze({
        kind: legacy.snapshotColumns.length === 3 ? 'exact' : 'upgradeable',
        lineage: legacy.lineage,
        table,
        indexes,
        missingSnapshotColumns: Object.freeze([
            'snapshot_json TEXT DEFAULT NULL',
            'snapshot_hash TEXT DEFAULT NULL',
            'snapshot_version INTEGER NOT NULL DEFAULT 1',
        ].slice(legacy.snapshotColumns.length)),
    });
}

async function completeRaidRewardProposalSnapshotPrefix(db, base) {
    for (const definition of base.missingSnapshotColumns || []) {
        const [name] = definition.split(/\s+/, 1);
        await db.exec(`ALTER TABLE clover_raid_reward_proposals ADD COLUMN ${definition}`);
        const column = await db.get(`SELECT name FROM pragma_table_info('clover_raid_reward_proposals') WHERE name = ?`, [name]);
        if (!column) throw new Error(`Nao foi possivel formalizar a coluna historica ${name}.`);
    }
}

async function inspectRaidRewardProposalHistoryObjects(db) {
    const state = await inspectRaidRewardProposalObjects(db, RAID_REWARD_PROPOSAL_HISTORY_OBJECTS);
    if (state.kind === 'absent' || state.kind === 'exact') return state;
    const firstMismatch = state.objects.findIndex((entry) => !entry.exists || !entry.exact);
    const exactPrefix = firstMismatch >= 0
        && state.objects.slice(0, firstMismatch).every((entry) => entry.exists && entry.exact)
        && state.objects.slice(firstMismatch).every((entry) => !entry.exists);
    return exactPrefix
        ? Object.freeze({ ...state, kind: 'prefix', prefixLength: firstMismatch })
        : state;
}

async function inspectRaidRewardProposalIdempotencyStoredState(db) {
    const invalidIntent = await db.get(`
        SELECT idempotency_key, status, decision
        FROM clover_raid_reward_review_intents
        WHERE status NOT IN ('pending', 'processing', 'completed')
           OR decision NOT IN ('approve', 'return', 'reject')
        LIMIT 1
    `);
    if (invalidIntent) return Object.freeze({ kind: 'intent_value', ...invalidIntent });
    const invalidEvent = await db.get(`
        SELECT idempotency_key, proposal_status, decision
        FROM clover_raid_reward_review_events
        WHERE decision NOT IN ('approve', 'return', 'reject')
           OR proposal_status NOT IN ('returned', 'rejected', 'delivered')
           OR (decision = 'approve' AND proposal_status <> 'delivered')
           OR (decision = 'return' AND proposal_status <> 'returned')
           OR (decision = 'reject' AND proposal_status <> 'rejected')
        LIMIT 1
    `);
    if (invalidEvent) return Object.freeze({ kind: 'event_value', ...invalidEvent });
    const orphan = await db.get(`
        SELECT review.source, review.idempotency_key, review.proposal_id, review.raid_id
        FROM (
            SELECT 'intent' AS source, idempotency_key, proposal_id, raid_id
            FROM clover_raid_reward_review_intents
            UNION ALL
            SELECT 'event' AS source, idempotency_key, proposal_id, raid_id
            FROM clover_raid_reward_review_events
        ) review
        LEFT JOIN clover_raid_reward_proposals proposal ON proposal.id = review.proposal_id
        WHERE proposal.id IS NULL OR proposal.raid_id <> review.raid_id
        LIMIT 1
    `);
    return orphan ? Object.freeze({ kind: 'orphan_or_raid_mismatch', ...orphan }) : null;
}

async function inspectRaidRewardProposalIdempotencySchemaState(db) {
    return Object.freeze({
        base: await inspectRaidRewardProposalBaseSchemaState(db),
        history: await inspectRaidRewardProposalHistorySchemaState(db),
        idempotency: await inspectRaidRewardProposalObjects(db, RAID_REWARD_PROPOSAL_IDEMPOTENCY_OBJECTS),
    });
}

const RAID_REWARD_PROPOSAL_IDEMPOTENCY_MIGRATION = Object.freeze({
    version: RAID_REWARD_PROPOSAL_IDEMPOTENCY_VERSION,
    key: RAID_REWARD_PROPOSAL_IDEMPOTENCY_KEY,
    description: 'Formaliza a extensao idempotente de revisao somente apos o historico canonico de propostas.',
    checksumMaterial: Object.freeze({
        idempotency: RAID_REWARD_PROPOSAL_IDEMPOTENCY_OBJECTS,
        prerequisite: 'raid-reward-proposal-history-0027-exact',
        revision: 'raid-reward-proposal-idempotency-fail-closed-v2',
    }),
    async up(db) {
        const before = await inspectRaidRewardProposalIdempotencySchemaState(db);
        if (before.base.kind !== 'exact' || before.history.history.kind !== 'exact') {
            const error = new Error('Idempotencia de revisao exige Family B historica canonica antes da migration 0028.');
            error.code = 'raid_reward_proposal_idempotency_base_mapping_required';
            error.base = before.base;
            error.history = before.history;
            error.idempotency = before.idempotency;
            throw error;
        }
        if (before.idempotency.kind !== 'absent' && before.idempotency.kind !== 'exact') {
            const error = new Error('Schema de idempotencia de proposta de recompensa parcial ou divergente exige reconciliacao explicita.');
            error.code = 'raid_reward_proposal_idempotency_schema_mapping_required';
            error.idempotency = before.idempotency;
            throw error;
        }
        if (before.idempotency.kind === 'absent') await createRaidRewardProposalObjects(db, RAID_REWARD_PROPOSAL_IDEMPOTENCY_OBJECTS);

        const after = await inspectRaidRewardProposalIdempotencySchemaState(db);
        if (after.base.kind !== 'exact' || after.history.history.kind !== 'exact' || after.idempotency.kind !== 'exact') {
            const error = new Error('Migration 0028 nao produziu o schema canonico de revisao idempotente.');
            error.code = 'raid_reward_proposal_idempotency_schema_mapping_required';
            error.base = after.base;
            error.idempotency = after.idempotency;
            throw error;
        }
        const invalidState = await inspectRaidRewardProposalIdempotencyStoredState(db);
        if (invalidState) {
            const error = new Error('Estado idempotente de proposta de recompensa exige reconciliacao explicita.');
            error.code = 'raid_reward_proposal_idempotency_state_mapping_required';
            error.state = invalidState;
            throw error;
        }
    },
});

const RAID_REWARD_PROPOSAL_HISTORY_OBJECTS = Object.freeze([
    Object.freeze({
        type: 'table', name: 'clover_raid_reward_proposal_authors',
        sql: `
CREATE TABLE clover_raid_reward_proposal_authors (
    proposal_id INTEGER NOT NULL,
    actor_id TEXT NOT NULL,
    first_action TEXT NOT NULL
        CHECK (first_action IN ('created', 'resubmitted', 'legacy_current_proposer')),
    first_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (proposal_id, actor_id),
    FOREIGN KEY (proposal_id) REFERENCES clover_raid_reward_proposals(id)
)
`,
    }),
    Object.freeze({
        type: 'index', name: 'idx_clover_raid_reward_proposal_authors_actor',
        table: 'clover_raid_reward_proposal_authors',
        sql: `
CREATE INDEX idx_clover_raid_reward_proposal_authors_actor
ON clover_raid_reward_proposal_authors (actor_id, proposal_id)
`,
    }),
    Object.freeze({
        type: 'trigger', name: 'trg_clover_raid_reward_proposal_author_insert',
        table: 'clover_raid_reward_proposals',
        sql: `
CREATE TRIGGER trg_clover_raid_reward_proposal_author_insert
AFTER INSERT ON clover_raid_reward_proposals
WHEN NEW.proposed_by IS NOT NULL AND TRIM(NEW.proposed_by) <> ''
BEGIN
    INSERT OR IGNORE INTO clover_raid_reward_proposal_authors
    (proposal_id, actor_id, first_action)
    VALUES (NEW.id, NEW.proposed_by, 'created');
END
`,
    }),
    Object.freeze({
        type: 'trigger', name: 'trg_clover_raid_reward_proposal_author_resubmit',
        table: 'clover_raid_reward_proposals',
        sql: `
CREATE TRIGGER trg_clover_raid_reward_proposal_author_resubmit
AFTER UPDATE OF proposed_by ON clover_raid_reward_proposals
WHEN NEW.proposed_by IS NOT NULL
     AND TRIM(NEW.proposed_by) <> ''
     AND COALESCE(NEW.proposed_by, '') <> COALESCE(OLD.proposed_by, '')
BEGIN
    INSERT OR IGNORE INTO clover_raid_reward_proposal_authors
    (proposal_id, actor_id, first_action)
    VALUES (NEW.id, NEW.proposed_by, 'resubmitted');
END
`,
    }),
    Object.freeze({
        type: 'trigger', name: 'trg_clover_raid_reward_proposal_self_review_block',
        table: 'clover_raid_reward_proposals',
        sql: `
CREATE TRIGGER trg_clover_raid_reward_proposal_self_review_block
BEFORE UPDATE OF status, reviewed_by ON clover_raid_reward_proposals
WHEN NEW.reviewed_by IS NOT NULL
     AND TRIM(NEW.reviewed_by) <> ''
     AND EXISTS (
         SELECT 1
         FROM clover_raid_reward_proposal_authors author
         WHERE author.proposal_id = NEW.id
           AND author.actor_id = NEW.reviewed_by
     )
BEGIN
    SELECT RAISE(ABORT, 'self_review_blocked');
END
`,
    }),
    Object.freeze({
        type: 'table', name: 'clover_raid_reward_proposal_revisions',
        sql: `
CREATE TABLE clover_raid_reward_proposal_revisions (
    proposal_id INTEGER NOT NULL,
    revision_number INTEGER NOT NULL CHECK (revision_number > 0),
    submitted_by TEXT NOT NULL,
    submission_action TEXT NOT NULL
        CHECK (submission_action IN ('created', 'resubmitted', 'legacy_current_snapshot')),
    proposal_status TEXT NOT NULL,
    snapshot_json TEXT DEFAULT NULL,
    snapshot_hash TEXT DEFAULT NULL,
    snapshot_version INTEGER NOT NULL DEFAULT 1,
    submitted_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (proposal_id, revision_number),
    FOREIGN KEY (proposal_id) REFERENCES clover_raid_reward_proposals(id)
)
`,
    }),
    Object.freeze({
        type: 'index', name: 'idx_clover_raid_reward_proposal_revisions_submitter',
        table: 'clover_raid_reward_proposal_revisions',
        sql: `
CREATE INDEX idx_clover_raid_reward_proposal_revisions_submitter
ON clover_raid_reward_proposal_revisions (submitted_by, proposal_id, revision_number)
`,
    }),
    Object.freeze({
        type: 'index', name: 'idx_clover_raid_reward_proposal_revisions_hash',
        table: 'clover_raid_reward_proposal_revisions',
        sql: `
CREATE INDEX idx_clover_raid_reward_proposal_revisions_hash
ON clover_raid_reward_proposal_revisions (proposal_id, snapshot_hash)
`,
    }),
    Object.freeze({
        type: 'trigger', name: 'trg_clover_raid_reward_proposal_revision_insert',
        table: 'clover_raid_reward_proposals',
        sql: `
CREATE TRIGGER trg_clover_raid_reward_proposal_revision_insert
AFTER INSERT ON clover_raid_reward_proposals
WHEN NEW.proposed_by IS NOT NULL AND TRIM(NEW.proposed_by) <> ''
BEGIN
    INSERT OR IGNORE INTO clover_raid_reward_proposal_revisions
    (proposal_id, revision_number, submitted_by, submission_action,
     proposal_status, snapshot_json, snapshot_hash, snapshot_version, submitted_at)
    VALUES (
        NEW.id,
        1,
        NEW.proposed_by,
        'created',
        NEW.status,
        NEW.snapshot_json,
        NEW.snapshot_hash,
        COALESCE(NEW.snapshot_version, 1),
        COALESCE(NEW.proposed_at, CURRENT_TIMESTAMP)
    );
END
`,
    }),
    Object.freeze({
        type: 'trigger', name: 'trg_clover_raid_reward_proposal_revision_resubmit',
        table: 'clover_raid_reward_proposals',
        sql: `
CREATE TRIGGER trg_clover_raid_reward_proposal_revision_resubmit
AFTER UPDATE OF status, proposed_by, snapshot_json, snapshot_hash, snapshot_version
ON clover_raid_reward_proposals
WHEN OLD.status = 'returned' AND NEW.status = 'pending'
BEGIN
    INSERT INTO clover_raid_reward_proposal_revisions
    (proposal_id, revision_number, submitted_by, submission_action,
     proposal_status, snapshot_json, snapshot_hash, snapshot_version, submitted_at)
    SELECT
        NEW.id,
        COALESCE(MAX(revision_number), 0) + 1,
        NEW.proposed_by,
        'resubmitted',
        NEW.status,
        NEW.snapshot_json,
        NEW.snapshot_hash,
        COALESCE(NEW.snapshot_version, 1),
        COALESCE(NEW.proposed_at, CURRENT_TIMESTAMP)
    FROM clover_raid_reward_proposal_revisions
    WHERE proposal_id = NEW.id;
END
`,
    }),
    Object.freeze({
        type: 'trigger', name: 'trg_clover_raid_reward_proposal_revision_update_block',
        table: 'clover_raid_reward_proposal_revisions',
        sql: `
CREATE TRIGGER trg_clover_raid_reward_proposal_revision_update_block
BEFORE UPDATE ON clover_raid_reward_proposal_revisions
BEGIN
    SELECT RAISE(ABORT, 'proposal_revision_immutable');
END
`,
    }),
    Object.freeze({
        type: 'trigger', name: 'trg_clover_raid_reward_proposal_revision_delete_block',
        table: 'clover_raid_reward_proposal_revisions',
        sql: `
CREATE TRIGGER trg_clover_raid_reward_proposal_revision_delete_block
BEFORE DELETE ON clover_raid_reward_proposal_revisions
BEGIN
    SELECT RAISE(ABORT, 'proposal_revision_immutable');
END
`,
    }),
]);

async function inspectRaidRewardProposalHistoryStoredState(db) {
    const invalidAuthor = await db.get(`
        SELECT author.proposal_id, author.actor_id, author.first_action
        FROM clover_raid_reward_proposal_authors author
        LEFT JOIN clover_raid_reward_proposals proposal ON proposal.id = author.proposal_id
        WHERE proposal.id IS NULL OR TRIM(author.actor_id) = ''
           OR author.first_action NOT IN ('created', 'resubmitted', 'legacy_current_proposer')
        LIMIT 1
    `);
    if (invalidAuthor) return Object.freeze({ kind: 'author', ...invalidAuthor });
    const missingCurrentAuthor = await db.get(`
        SELECT proposal.id AS proposal_id, proposal.proposed_by AS actor_id
        FROM clover_raid_reward_proposals proposal
        WHERE NOT EXISTS (
            SELECT 1 FROM clover_raid_reward_proposal_authors author
            WHERE author.proposal_id = proposal.id AND author.actor_id = proposal.proposed_by
        )
        LIMIT 1
    `);
    if (missingCurrentAuthor) return Object.freeze({ kind: 'current_author_missing', ...missingCurrentAuthor });
    const invalidRevision = await db.get(`
        SELECT revision.proposal_id, revision.revision_number, revision.submission_action
        FROM clover_raid_reward_proposal_revisions revision
        LEFT JOIN clover_raid_reward_proposals proposal ON proposal.id = revision.proposal_id
        WHERE proposal.id IS NULL OR TRIM(revision.submitted_by) = ''
           OR revision.submission_action NOT IN ('created', 'resubmitted', 'legacy_current_snapshot')
           OR revision.proposal_status NOT IN ('pending', 'returned', 'approved', 'rejected', 'delivered')
        LIMIT 1
    `);
    if (invalidRevision) return Object.freeze({ kind: 'revision', ...invalidRevision });
    const invalidSequence = await db.get(`
        SELECT proposal_id, MIN(revision_number) AS first_revision,
               MAX(revision_number) AS last_revision, COUNT(*) AS revision_count
        FROM clover_raid_reward_proposal_revisions
        GROUP BY proposal_id
        HAVING MIN(revision_number) <> 1 OR MAX(revision_number) <> COUNT(*)
        LIMIT 1
    `);
    if (invalidSequence) return Object.freeze({ kind: 'revision_sequence', ...invalidSequence });
    const invalidActionOrder = await db.get(`
        SELECT proposal_id, revision_number, submission_action
        FROM clover_raid_reward_proposal_revisions
        WHERE (revision_number = 1 AND submission_action NOT IN ('created', 'legacy_current_snapshot'))
           OR (revision_number > 1 AND submission_action <> 'resubmitted')
        LIMIT 1
    `);
    if (invalidActionOrder) return Object.freeze({ kind: 'revision_action_order', ...invalidActionOrder });
    const missingCurrentRevision = await db.get(`
        SELECT proposal.id AS proposal_id
        FROM clover_raid_reward_proposals proposal
        WHERE NOT EXISTS (
            SELECT 1 FROM clover_raid_reward_proposal_revisions revision
            WHERE revision.proposal_id = proposal.id
        )
        LIMIT 1
    `);
    if (missingCurrentRevision) return Object.freeze({ kind: 'current_revision_missing', ...missingCurrentRevision });
    const currentMismatch = await db.get(`
        SELECT proposal.id AS proposal_id, revision.revision_number
        FROM clover_raid_reward_proposals proposal
        JOIN clover_raid_reward_proposal_revisions revision
          ON revision.proposal_id = proposal.id
         AND revision.revision_number = (
             SELECT MAX(current_revision.revision_number)
             FROM clover_raid_reward_proposal_revisions current_revision
             WHERE current_revision.proposal_id = proposal.id
         )
        WHERE revision.submitted_by <> proposal.proposed_by
           OR revision.snapshot_json IS NOT proposal.snapshot_json
           OR revision.snapshot_hash IS NOT proposal.snapshot_hash
           OR revision.snapshot_version <> proposal.snapshot_version
        LIMIT 1
    `);
    return currentMismatch ? Object.freeze({ kind: 'current_revision_mismatch', ...currentMismatch }) : null;
}

async function inspectRaidRewardProposalHistorySchemaState(db) {
    return Object.freeze({
        base: await inspectRaidRewardProposalBaseSchemaState(db),
        history: await inspectRaidRewardProposalHistoryObjects(db),
        idempotency: await inspectRaidRewardProposalObjects(db, RAID_REWARD_PROPOSAL_IDEMPOTENCY_OBJECTS),
    });
}

async function backfillRaidRewardProposalHistory(db) {
    await db.run(`
        INSERT OR IGNORE INTO clover_raid_reward_proposal_authors
        (proposal_id, actor_id, first_action)
        SELECT id, proposed_by, 'legacy_current_proposer'
        FROM clover_raid_reward_proposals
        WHERE proposed_by IS NOT NULL AND TRIM(proposed_by) <> ''
    `);
    await db.run(`
        INSERT OR IGNORE INTO clover_raid_reward_proposal_revisions
        (proposal_id, revision_number, submitted_by, submission_action,
         proposal_status, snapshot_json, snapshot_hash, snapshot_version, submitted_at)
        SELECT id, 1, proposed_by, 'legacy_current_snapshot', status,
               snapshot_json, snapshot_hash, COALESCE(snapshot_version, 1),
               COALESCE(proposed_at, CURRENT_TIMESTAMP)
        FROM clover_raid_reward_proposals
        WHERE proposed_by IS NOT NULL AND TRIM(proposed_by) <> ''
    `);
}

const RAID_REWARD_PROPOSAL_HISTORY_MIGRATION = Object.freeze({
    version: RAID_REWARD_PROPOSAL_HISTORY_VERSION,
    key: RAID_REWARD_PROPOSAL_HISTORY_KEY,
    description: 'Formaliza Family B: propostas, autoria e revisoes imutaveis antes da idempotencia de revisao.',
    checksumMaterial: Object.freeze({
        base: RAID_REWARD_PROPOSAL_BASE_OBJECTS,
        history: RAID_REWARD_PROPOSAL_HISTORY_OBJECTS,
        backfill: 'historical-insert-or-ignore-current-proposer-and-snapshot-only',
        lineage: 'pre-snapshot-and-exact-prefixes-only',
        revision: 'raid-reward-proposal-history-fail-closed-v2',
    }),
    async up(db) {
        const before = await inspectRaidRewardProposalHistorySchemaState(db);
        if (before.idempotency.kind !== 'absent') {
            if (before.idempotency.kind === 'exact' && before.base.kind === 'exact' && before.history.kind === 'exact') return;
            const error = new Error('Family C presente sem Family B exata exige reconciliacao explicita.');
            error.code = 'raid_reward_proposal_history_c_mapping_required';
            error.base = before.base;
            error.history = before.history;
            error.idempotency = before.idempotency;
            throw error;
        }
        if (before.base.kind !== 'absent' && before.base.kind !== 'exact' && before.base.kind !== 'upgradeable') {
            const error = new Error('Historico de proposta exige lineage de proposta comprovada antes da migration 0027.');
            error.code = 'raid_reward_proposal_history_base_mapping_required';
            error.base = before.base;
            throw error;
        }
        if (before.history.kind !== 'absent' && before.history.kind !== 'exact' && before.history.kind !== 'prefix') {
            const error = new Error('Schema de historico de proposta parcial ou divergente exige reconciliacao explicita.');
            error.code = 'raid_reward_proposal_history_schema_mapping_required';
            error.history = before.history;
            throw error;
        }
        if (before.base.kind === 'absent') {
            await createRaidRewardProposalObjects(db, RAID_REWARD_PROPOSAL_BASE_OBJECTS);
        } else if (before.base.kind === 'upgradeable') {
            await completeRaidRewardProposalSnapshotPrefix(db, before.base);
        }
        if (before.history.kind !== 'exact') {
            const currentHistory = await inspectRaidRewardProposalHistoryObjects(db);
            const missingNonTriggers = RAID_REWARD_PROPOSAL_HISTORY_OBJECTS.filter((entry) => (
                entry.type !== 'trigger' && !currentHistory.objects.find((observed) => observed.name === entry.name)?.exists
            ));
            await createRaidRewardProposalObjects(db, missingNonTriggers);
            await backfillRaidRewardProposalHistory(db);
            const afterBackfill = await inspectRaidRewardProposalHistoryObjects(db);
            const missingTriggers = RAID_REWARD_PROPOSAL_HISTORY_OBJECTS.filter((entry) => (
                entry.type === 'trigger' && !afterBackfill.objects.find((observed) => observed.name === entry.name)?.exists
            ));
            await createRaidRewardProposalObjects(db, missingTriggers);
        }
        const after = await inspectRaidRewardProposalHistorySchemaState(db);
        if (after.base.kind !== 'exact' || after.history.kind !== 'exact' || after.idempotency.kind !== 'absent') {
            const error = new Error('Migration 0027 nao produziu a Family B canonica de propostas.');
            error.code = 'raid_reward_proposal_history_schema_mapping_required';
            error.base = after.base;
            error.history = after.history;
            throw error;
        }
        const invalidState = await inspectRaidRewardProposalHistoryStoredState(db);
        if (invalidState) {
            const error = new Error('Historico armazenado de proposta de recompensa exige reconciliacao explicita.');
            error.code = 'raid_reward_proposal_history_state_mapping_required';
            error.state = invalidState;
            throw error;
        }
    },
});

function normalizePreResetSchemaSql(sql) {
    return String(sql || '').replace(/\s+/g, ' ').trim();
}

const PRERESET_CHARACTER_LAUNCH_OBJECTS = Object.freeze([
    Object.freeze({
        type: 'table', name: 'clover_prereset_characters', sql: `
CREATE TABLE clover_prereset_characters (
    player_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'submitted', 'approved', 'locked')),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    draft_json TEXT NOT NULL DEFAULT '{}',
    draft_hash TEXT NOT NULL,
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    submitted_at TEXT DEFAULT NULL,
    approved_at TEXT DEFAULT NULL,
    locked_at TEXT DEFAULT NULL,
    applied_at_reset TEXT DEFAULT NULL,
    provenance_json TEXT NOT NULL DEFAULT '{}'
)
`,
    }),
    Object.freeze({
        type: 'index', name: 'idx_clover_prereset_characters_status',
        table: 'clover_prereset_characters', sql: `
CREATE INDEX idx_clover_prereset_characters_status
ON clover_prereset_characters (status, updated_at, player_id)
`,
    }),
    Object.freeze({
        type: 'trigger', name: 'trg_clover_prereset_characters_no_apply',
        table: 'clover_prereset_characters', sql: `
CREATE TRIGGER trg_clover_prereset_characters_no_apply
BEFORE INSERT ON clover_prereset_characters
WHEN NEW.applied_at_reset IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'prereset_apply_not_available');
END
`,
    }),
    Object.freeze({
        type: 'trigger', name: 'trg_clover_prereset_characters_no_apply_update',
        table: 'clover_prereset_characters', sql: `
CREATE TRIGGER trg_clover_prereset_characters_no_apply_update
BEFORE UPDATE OF applied_at_reset ON clover_prereset_characters
WHEN NEW.applied_at_reset IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'prereset_apply_not_available');
END
`,
    }),
    Object.freeze({
        type: 'table', name: 'clover_prereset_character_operations', sql: `
CREATE TABLE clover_prereset_character_operations (
    operation_key TEXT PRIMARY KEY,
    player_id TEXT NOT NULL,
    operation_type TEXT NOT NULL CHECK (operation_type IN ('create', 'update', 'submit')),
    request_hash TEXT NOT NULL,
    character_revision INTEGER NOT NULL CHECK (character_revision > 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)
`,
    }),
    Object.freeze({
        type: 'index', name: 'idx_clover_prereset_character_operations_player',
        table: 'clover_prereset_character_operations', sql: `
CREATE INDEX idx_clover_prereset_character_operations_player
ON clover_prereset_character_operations (player_id, created_at, operation_type)
`,
    }),
    Object.freeze({
        type: 'table', name: 'clover_prereset_character_reviews', sql: `
CREATE TABLE clover_prereset_character_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_key TEXT NOT NULL UNIQUE,
    player_id TEXT NOT NULL,
    previous_revision INTEGER NOT NULL CHECK (previous_revision > 0),
    resulting_revision INTEGER NOT NULL CHECK (resulting_revision > previous_revision),
    action TEXT NOT NULL CHECK (action IN ('approve', 'lock')),
    reason TEXT NOT NULL,
    reviewed_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)
`,
    }),
    Object.freeze({
        type: 'index', name: 'idx_clover_prereset_character_reviews_player',
        table: 'clover_prereset_character_reviews', sql: `
CREATE INDEX idx_clover_prereset_character_reviews_player
ON clover_prereset_character_reviews (player_id, resulting_revision, created_at)
`,
    }),
    Object.freeze({
        type: 'table', name: 'clover_return_points_ledger', sql: `
CREATE TABLE clover_return_points_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount <> 0),
    entry_kind TEXT NOT NULL CHECK (entry_kind IN ('credit', 'debit', 'refund', 'compensation')),
    operation_key TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL,
    reason TEXT NOT NULL,
    policy_version TEXT DEFAULT NULL,
    reset_cycle_key TEXT DEFAULT NULL,
    related_id TEXT DEFAULT NULL,
    correlation_id TEXT DEFAULT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    metadata_json TEXT NOT NULL DEFAULT '{}'
)
`,
    }),
    Object.freeze({
        type: 'index', name: 'idx_clover_return_points_ledger_player',
        table: 'clover_return_points_ledger', sql: `
CREATE INDEX idx_clover_return_points_ledger_player
ON clover_return_points_ledger (player_id, id)
`,
    }),
    Object.freeze({
        type: 'trigger', name: 'trg_clover_return_points_ledger_immutable_update',
        table: 'clover_return_points_ledger', sql: `
CREATE TRIGGER trg_clover_return_points_ledger_immutable_update
BEFORE UPDATE ON clover_return_points_ledger
BEGIN
    SELECT RAISE(ABORT, 'return_points_ledger_immutable');
END
`,
    }),
    Object.freeze({
        type: 'trigger', name: 'trg_clover_return_points_ledger_immutable_delete',
        table: 'clover_return_points_ledger', sql: `
CREATE TRIGGER trg_clover_return_points_ledger_immutable_delete
BEFORE DELETE ON clover_return_points_ledger
BEGIN
    SELECT RAISE(ABORT, 'return_points_ledger_immutable');
END
`,
    }),
    Object.freeze({
        type: 'table', name: 'clover_return_point_conversion_claims', sql: `
CREATE TABLE clover_return_point_conversion_claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    reset_cycle_key TEXT NOT NULL,
    claim_key TEXT NOT NULL UNIQUE,
    source_ph_ledger_digest TEXT NOT NULL,
    source_ph_available INTEGER NOT NULL,
    calculated_return_points INTEGER NOT NULL CHECK (calculated_return_points >= 0),
    status TEXT NOT NULL CHECK (status IN ('previewed', 'claimed', 'reconciled', 'disabled')),
    return_points_ledger_id INTEGER DEFAULT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    claimed_at TEXT DEFAULT NULL,
    reconciled_at TEXT DEFAULT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE (player_id, policy_version, reset_cycle_key),
    FOREIGN KEY (return_points_ledger_id) REFERENCES clover_return_points_ledger(id)
)
`,
    }),
    Object.freeze({
        type: 'index', name: 'idx_clover_return_point_conversion_claims_player',
        table: 'clover_return_point_conversion_claims', sql: `
CREATE INDEX idx_clover_return_point_conversion_claims_player
ON clover_return_point_conversion_claims (player_id, policy_version, reset_cycle_key)
`,
    }),
    Object.freeze({
        type: 'table', name: 'clover_prereset_purchases', sql: `
CREATE TABLE clover_prereset_purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    catalog_item_key TEXT NOT NULL,
    entitlement_key TEXT NOT NULL,
    price_return_points INTEGER NOT NULL CHECK (price_return_points > 0),
    return_points_ledger_id INTEGER NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'refunded')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    refunded_at TEXT DEFAULT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY (return_points_ledger_id) REFERENCES clover_return_points_ledger(id)
)
`,
    }),
    Object.freeze({
        type: 'index', name: 'idx_clover_prereset_purchases_player',
        table: 'clover_prereset_purchases', sql: `
CREATE INDEX idx_clover_prereset_purchases_player
ON clover_prereset_purchases (player_id, created_at, status)
`,
    }),
    Object.freeze({
        type: 'table', name: 'clover_prereset_entitlements', sql: `
CREATE TABLE clover_prereset_entitlements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id TEXT NOT NULL,
    entitlement_key TEXT NOT NULL,
    purchase_id INTEGER NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'granted' CHECK (status IN ('granted', 'reserved', 'revoked')),
    reserved_for_player_id TEXT DEFAULT NULL,
    granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revoked_at TEXT DEFAULT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE (player_id, entitlement_key),
    FOREIGN KEY (purchase_id) REFERENCES clover_prereset_purchases(id)
)
`,
    }),
    Object.freeze({
        type: 'index', name: 'idx_clover_prereset_entitlements_player',
        table: 'clover_prereset_entitlements', sql: `
CREATE INDEX idx_clover_prereset_entitlements_player
ON clover_prereset_entitlements (player_id, status, entitlement_key)
`,
    }),
]);

async function inspectPreResetCharacterLaunchSchemaState(db) {
    const names = PRERESET_CHARACTER_LAUNCH_OBJECTS.map((entry) => entry.name);
    const placeholders = names.map(() => '?').join(', ');
    const rows = await db.all(
        `SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name IN (${placeholders})`,
        names
    );
    const byName = new Map(rows.map((row) => [row.name, row]));
    const objects = PRERESET_CHARACTER_LAUNCH_OBJECTS.map((expected) => {
        const observed = byName.get(expected.name) || null;
        return Object.freeze({
            name: expected.name,
            exists: Boolean(observed),
            exact: Boolean(observed)
                && observed.type === expected.type
                && (expected.type !== 'index' || observed.tbl_name === expected.table)
                && normalizePreResetSchemaSql(observed.sql) === normalizePreResetSchemaSql(expected.sql),
        });
    });
    if (objects.every((entry) => !entry.exists)) return Object.freeze({ kind: 'absent', objects });
    if (objects.every((entry) => entry.exact)) return Object.freeze({ kind: 'exact', objects });
    return Object.freeze({ kind: 'partial_or_divergent', objects });
}

async function createPreResetCharacterLaunchObjects(db) {
    for (const object of PRERESET_CHARACTER_LAUNCH_OBJECTS) await db.exec(object.sql);
}

const PRERESET_CHARACTER_LAUNCH_MIGRATION = Object.freeze({
    version: PRERESET_CHARACTER_LAUNCH_VERSION,
    key: PRERESET_CHARACTER_LAUNCH_KEY,
    description: 'Formaliza o aggregate de personagem futuro, Return Points e entitlements pre-reset desativados.',
    checksumMaterial: Object.freeze({
        objects: PRERESET_CHARACTER_LAUNCH_OBJECTS,
        invariant: 'separate-from-active-character-ph-and-recruitment-pr',
        revision: 'prereset-launch-foundation-v1',
    }),
    async up(db) {
        const before = await inspectPreResetCharacterLaunchSchemaState(db);
        if (before.kind === 'exact') return;
        if (before.kind !== 'absent') {
            const error = new Error('Schema pre-reset parcial ou divergente exige reconciliacao explicita.');
            error.code = 'prereset_character_launch_schema_mapping_required';
            error.state = before;
            throw error;
        }
        await createPreResetCharacterLaunchObjects(db);
        const after = await inspectPreResetCharacterLaunchSchemaState(db);
        if (after.kind !== 'exact') {
            const error = new Error('Migration pre-reset nao produziu o schema canonico.');
            error.code = 'prereset_character_launch_schema_mapping_required';
            error.state = after;
            throw error;
        }
    },
});

const CURRENT_SCHEMA_MIGRATIONS = Object.freeze([
    ...CORE_MIGRATIONS,
    MARKET_REQUEST_MIGRATION,
    QUICK_EVALUATION_MIGRATION,
    PLAYER_ROLLS_MIGRATION,
    ITEM_TEMPLATES_MIGRATION,
    INVENTORY_ITEMS_MIGRATION,
    ADMIN_SERVICE_MIGRATION,
    PLAYER_PROFILE_MIGRATION,
    CHARACTER_IDENTITY_MIGRATION,
    APPEARANCE_MODERATION_MIGRATION,
    SITE_PROFILE_IMAGE_MIGRATION,
    CHARACTER_TRAITS_MIGRATION,
    ROLL_ATTEMPT_STATE_MIGRATION,
    STORY_STATE_MIGRATION,
    GAME_STATE_MIGRATION,
    PLAYER_PATENT_MIGRATION,
    SQUAD_COLUMNS_MIGRATION,
    RAID_V1_BRIDGE_MIGRATION,
    RAID_V2_COLUMNS_MIGRATION,
    RAID_PARTICIPANT_FINALIZATION_MIGRATION,
    RAID_REWARDS_V2_MIGRATION,
    RAID_MONTHLY_PROGRESS_MIGRATION,
    RAID_SUPPORT_TABLES_MIGRATION,
    RAID_IDEMPOTENCY_REQUESTS_MIGRATION,
    RAID_REWARD_PROPOSAL_HISTORY_MIGRATION,
    RAID_REWARD_PROPOSAL_IDEMPOTENCY_MIGRATION,
    PRERESET_CHARACTER_LAUNCH_MIGRATION,
]);

module.exports = {
    CURRENT_SCHEMA_MIGRATIONS,
    PRERESET_CHARACTER_LAUNCH_KEY,
    PRERESET_CHARACTER_LAUNCH_MIGRATION,
    PRERESET_CHARACTER_LAUNCH_OBJECTS,
    PRERESET_CHARACTER_LAUNCH_VERSION,
    MARKET_REQUEST_KEY,
    MARKET_REQUEST_MIGRATION,
    MARKET_REQUEST_TARGETS,
    MARKET_REQUEST_VERSION,
    QUICK_EVALUATION_KEY,
    QUICK_EVALUATION_MIGRATION,
    QUICK_EVALUATION_TARGETS,
    QUICK_EVALUATION_VERSION,
    PLAYER_ROLLS_KEY,
    PLAYER_ROLLS_MIGRATION,
    PLAYER_ROLLS_TARGETS,
    PLAYER_ROLLS_VERSION,
    ITEM_TEMPLATES_KEY,
    ITEM_TEMPLATES_MIGRATION,
    ITEM_TEMPLATES_TARGETS,
    ITEM_TEMPLATES_VERSION,
    INVENTORY_ITEMS_KEY,
    INVENTORY_ITEMS_MIGRATION,
    INVENTORY_ITEMS_TARGETS,
    INVENTORY_ITEMS_VERSION,
    ADMIN_SERVICE_KEY,
    ADMIN_SERVICE_MIGRATION,
    ADMIN_SERVICE_TARGETS,
    ADMIN_SERVICE_VERSION,
    PLAYER_PROFILE_KEY,
    PLAYER_PROFILE_MIGRATION,
    PLAYER_PROFILE_TARGETS,
    PLAYER_PROFILE_VERSION,
    CHARACTER_IDENTITY_KEY,
    CHARACTER_IDENTITY_MIGRATION,
    CHARACTER_IDENTITY_TARGETS,
    CHARACTER_IDENTITY_VERSION,
    APPEARANCE_MODERATION_KEY,
    APPEARANCE_MODERATION_MIGRATION,
    APPEARANCE_MODERATION_TARGETS,
    APPEARANCE_MODERATION_VERSION,
    SITE_PROFILE_IMAGE_KEY,
    SITE_PROFILE_IMAGE_MIGRATION,
    SITE_PROFILE_IMAGE_TARGETS,
    SITE_PROFILE_IMAGE_VERSION,
    CHARACTER_TRAITS_KEY,
    CHARACTER_TRAITS_MIGRATION,
    CHARACTER_TRAITS_TARGETS,
    CHARACTER_TRAITS_VERSION,
    ROLL_ATTEMPT_STATE_KEY,
    ROLL_ATTEMPT_STATE_MIGRATION,
    ROLL_ATTEMPT_STATE_TARGETS,
    ROLL_ATTEMPT_STATE_VERSION,
    STORY_STATE_KEY,
    STORY_STATE_MIGRATION,
    STORY_STATE_TARGETS,
    STORY_STATE_VERSION,
    GAME_STATE_KEY,
    GAME_STATE_MIGRATION,
    GAME_STATE_TARGETS,
    GAME_STATE_VERSION,
    PLAYER_PATENT_KEY,
    PLAYER_PATENT_MIGRATION,
    PLAYER_PATENT_TARGETS,
    PLAYER_PATENT_VERSION,
    SQUAD_COLUMNS_KEY,
    SQUAD_COLUMNS_MIGRATION,
    SQUAD_COLUMNS_TARGETS,
    SQUAD_COLUMNS_VERSION,
    RAID_V1_BRIDGE_ALLOWED_PARTICIPANT_STATUSES,
    RAID_V1_BRIDGE_ALLOWED_RAID_STATUSES,
    RAID_V1_BRIDGE_KEY,
    RAID_V1_BRIDGE_MIGRATION,
    RAID_V1_BRIDGE_TARGETS,
    RAID_V1_BRIDGE_VERSION,
    RAID_V2_ALLOWED_SCOPE_TYPES,
    RAID_V2_CANONICAL_CATEGORY_KEYS,
    RAID_V2_COLUMNS_KEY,
    RAID_V2_COLUMNS_MIGRATION,
    RAID_V2_COLUMNS_TARGETS,
    RAID_V2_COLUMNS_VERSION,
    RAID_V2_MONTH_TIME_ZONE,
    RAID_PARTICIPANT_FINALIZATION_INDEX,
    RAID_PARTICIPANT_FINALIZATION_KEY,
    RAID_PARTICIPANT_FINALIZATION_MIGRATION,
    RAID_PARTICIPANT_FINALIZATION_STORED_STATUSES,
    RAID_PARTICIPANT_FINALIZATION_TARGETS,
    RAID_PARTICIPANT_FINALIZATION_VERSION,
    RAID_REWARDS_V1_TABLE_SQL,
    RAID_REWARDS_V2_INDEX,
    RAID_REWARDS_V2_KEY,
    RAID_REWARDS_V2_MIGRATION,
    RAID_REWARDS_V2_REWARD_TYPES,
    RAID_REWARDS_V2_TABLE_SQL,
    RAID_REWARDS_V2_VERSION,
    RAID_MONTHLY_LEDGER_TABLE_SQL,
    RAID_MONTHLY_PROGRESS_INDEXES,
    RAID_MONTHLY_PROGRESS_KEY,
    RAID_MONTHLY_PROGRESS_MIGRATION,
    RAID_MONTHLY_PROGRESS_VERSION,
    RAID_MONTHLY_RESERVATIONS_TABLE_SQL,
    RAID_SUPPORT_INDEXES,
    RAID_SUPPORT_TABLES,
    RAID_SUPPORT_TABLES_KEY,
    RAID_SUPPORT_TABLES_MIGRATION,
    RAID_SUPPORT_TABLES_VERSION,
    RAID_IDEMPOTENCY_REQUESTS_INDEXES,
    RAID_IDEMPOTENCY_REQUESTS_KEY,
    RAID_IDEMPOTENCY_REQUESTS_MIGRATION,
    RAID_IDEMPOTENCY_REQUESTS_TABLES,
    RAID_IDEMPOTENCY_REQUESTS_VERSION,
    RAID_REWARD_PROPOSAL_BASE_OBJECTS,
    RAID_REWARD_PROPOSAL_LEGACY_BASE_TABLES,
    RAID_REWARD_PROPOSAL_HISTORY_KEY,
    RAID_REWARD_PROPOSAL_HISTORY_MIGRATION,
    RAID_REWARD_PROPOSAL_HISTORY_OBJECTS,
    RAID_REWARD_PROPOSAL_HISTORY_VERSION,
    RAID_REWARD_PROPOSAL_IDEMPOTENCY_KEY,
    RAID_REWARD_PROPOSAL_IDEMPOTENCY_MIGRATION,
    RAID_REWARD_PROPOSAL_IDEMPOTENCY_OBJECTS,
    RAID_REWARD_PROPOSAL_IDEMPOTENCY_VERSION,
    inspectRaidIdempotencyRequestsSchemaState,
    inspectRaidRewardProposalBaseSchemaState,
    inspectRaidRewardProposalHistorySchemaState,
    inspectRaidRewardProposalHistoryStoredState,
    inspectRaidRewardProposalIdempotencySchemaState,
    inspectRaidRewardProposalIdempotencyStoredState,
    inspectRaidMonthlyProgressSchemaState,
    inspectRaidSupportSchemaState,
    inspectRaidRewardsSchemaState,
    inspectPreResetCharacterLaunchSchemaState,
    raidV2MigrationMonthKey,
};
