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
};