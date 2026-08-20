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
]);

module.exports = {
    CURRENT_SCHEMA_MIGRATIONS,
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
    raidV2MigrationMonthKey,
};