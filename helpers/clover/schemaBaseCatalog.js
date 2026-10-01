'use strict';

const MIGRATED_BASE_TABLES = Object.freeze([
    Object.freeze({
        table: 'clover_character_stats',
        sql: `
            CREATE TABLE IF NOT EXISTS clover_character_stats (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                player_id TEXT NOT NULL UNIQUE,
                stage_key TEXT DEFAULT '9',
                pb_total INTEGER DEFAULT 10,
                pb_spent INTEGER DEFAULT 0,
                ph_accumulated INTEGER DEFAULT 0,
                ph_available INTEGER DEFAULT 0,
                forca INTEGER DEFAULT 0,
                velocidade INTEGER DEFAULT 0,
                agilidade INTEGER DEFAULT 0,
                resistencia INTEGER DEFAULT 0,
                poder_magico INTEGER DEFAULT 0,
                distribution_status TEXT DEFAULT 'pending'
                    CHECK (distribution_status IN ('pending', 'pending_confirmation', 'confirmed')),
                pending_distribution_json TEXT DEFAULT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                confirmed_at TEXT DEFAULT NULL
            )
        `,
    }),
    Object.freeze({
        table: 'clover_box_openings',
        sql: `
            CREATE TABLE IF NOT EXISTS clover_box_openings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                player_id TEXT NOT NULL,
                inventory_item_id INTEGER DEFAULT NULL,
                box_key TEXT NOT NULL,
                catalog_version INTEGER NOT NULL,
                roll INTEGER NOT NULL CHECK (roll BETWEEN 1 AND 100),
                roll_basis_points INTEGER DEFAULT NULL,
                reward_key TEXT NOT NULL,
                result_json TEXT DEFAULT NULL,
                status TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'completed', 'failed')),
                idempotency_key TEXT NOT NULL UNIQUE,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                completed_at TEXT DEFAULT NULL,
                metadata_json TEXT DEFAULT NULL
            )
        `,
    }),
    Object.freeze({
        table: 'clover_inventory_reservations',
        sql: `
            CREATE TABLE IF NOT EXISTS clover_inventory_reservations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                reservation_key TEXT NOT NULL UNIQUE,
                inventory_item_id INTEGER NOT NULL,
                player_id TEXT NOT NULL,
                quantity INTEGER NOT NULL CHECK (quantity >= 0),
                source_type TEXT NOT NULL,
                source_id TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'released', 'consumed')),
                created_by TEXT DEFAULT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                released_at TEXT DEFAULT NULL,
                metadata_json TEXT DEFAULT NULL
            )
        `,
    }),
    Object.freeze({
        table: 'clover_consumable_uses',
        sql: `
            CREATE TABLE IF NOT EXISTS clover_consumable_uses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                player_id TEXT NOT NULL,
                inventory_item_id INTEGER DEFAULT NULL,
                template_key TEXT DEFAULT NULL,
                quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
                context_type TEXT NOT NULL DEFAULT 'livre',
                context_id TEXT DEFAULT NULL,
                effect_key TEXT DEFAULT NULL,
                effect_category TEXT DEFAULT NULL,
                result TEXT NOT NULL DEFAULT 'used',
                idempotency_key TEXT NOT NULL UNIQUE,
                used_at TEXT DEFAULT CURRENT_TIMESTAMP,
                metadata_json TEXT DEFAULT NULL
            )
        `,
    }),
    Object.freeze({
        table: 'player_onboarding',
        sql: `
            CREATE TABLE IF NOT EXISTS player_onboarding (
                player_id TEXT PRIMARY KEY,
                started_at TEXT DEFAULT CURRENT_TIMESTAMP,
                welcome_sent_at TEXT DEFAULT CURRENT_TIMESTAMP,
                last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
                current_step TEXT DEFAULT 'inicio'
            )
        `,
    }),
    Object.freeze({
        table: 'pending_magic_confirmations',
        sql: `
            CREATE TABLE IF NOT EXISTS pending_magic_confirmations (
                player_id TEXT PRIMARY KEY,
                magic_label TEXT NOT NULL,
                roll_number INTEGER DEFAULT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
        `,
    }),
    Object.freeze({
        table: 'group_settings',
        sql: `
            CREATE TABLE IF NOT EXISTS group_settings (
                group_id TEXT PRIMARY KEY,
                enabled INTEGER DEFAULT 0,
                reception_enabled INTEGER DEFAULT 0,
                reception_type TEXT DEFAULT NULL,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
        `,
    }),
    Object.freeze({
        table: 'clover_market_listings',
        sql: `
            CREATE TABLE IF NOT EXISTS clover_market_listings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                listing_key TEXT NOT NULL UNIQUE,
                seller_id TEXT NOT NULL,
                listing_type TEXT NOT NULL CHECK (listing_type IN ('fixed', 'auction')),
                inventory_item_id INTEGER NOT NULL,
                quantity INTEGER NOT NULL CHECK (quantity > 0),
                sold_quantity INTEGER NOT NULL DEFAULT 0 CHECK (sold_quantity >= 0),
                unit_price INTEGER DEFAULT NULL CHECK (unit_price IS NULL OR unit_price > 0),
                starting_bid INTEGER DEFAULT NULL CHECK (starting_bid IS NULL OR starting_bid > 0),
                publication_fee INTEGER NOT NULL CHECK (publication_fee >= 20),
                sale_fee_percent INTEGER NOT NULL DEFAULT 5 CHECK (sale_fee_percent BETWEEN 0 AND 100),
                inventory_reservation_id INTEGER NOT NULL,
                idempotency_key TEXT DEFAULT NULL,
                status TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'sold', 'cancelled', 'expired', 'ended_no_bids')),
                original_ends_at TEXT NOT NULL,
                ends_at TEXT NOT NULL,
                extension_minutes INTEGER NOT NULL DEFAULT 0 CHECK (extension_minutes BETWEEN 0 AND 30),
                winner_id TEXT DEFAULT NULL,
                winning_bid INTEGER DEFAULT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                completed_at TEXT DEFAULT NULL,
                cancelled_at TEXT DEFAULT NULL,
                metadata_json TEXT DEFAULT NULL
            )
        `,
    }),
    Object.freeze({
        table: 'clover_weekly_npc_requests',
        sql: `
            CREATE TABLE IF NOT EXISTS clover_weekly_npc_requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                request_key TEXT NOT NULL UNIQUE,
                week_key TEXT NOT NULL,
                npc_name TEXT NOT NULL,
                template_key TEXT NOT NULL,
                item_name TEXT NOT NULL,
                description TEXT DEFAULT NULL,
                price_percent INTEGER NOT NULL CHECK (price_percent BETWEEN 80 AND 120),
                unit_price INTEGER NOT NULL CHECK (unit_price > 0),
                global_quantity INTEGER NOT NULL CHECK (global_quantity > 0),
                delivered_quantity INTEGER NOT NULL DEFAULT 0 CHECK (delivered_quantity >= 0),
                personal_limit INTEGER NOT NULL CHECK (personal_limit > 0),
                status TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'fulfilled', 'expired', 'cancelled')),
                starts_at TEXT NOT NULL,
                ends_at TEXT NOT NULL,
                created_by TEXT NOT NULL DEFAULT 'system',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                metadata_json TEXT DEFAULT NULL,
                UNIQUE (week_key, template_key)
            )
        `,
    }),
    Object.freeze({
        table: 'clover_quick_evaluations',
        sql: `
            CREATE TABLE IF NOT EXISTS clover_quick_evaluations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message_key TEXT NOT NULL UNIQUE,
                quoted_message_key TEXT DEFAULT NULL,
                chat_id TEXT NOT NULL,
                player_id TEXT NOT NULL,
                evaluator_id TEXT NOT NULL,
                modality_key TEXT NOT NULL,
                modality_label TEXT NOT NULL,
                ph_amount INTEGER DEFAULT 0,
                yulls_amount INTEGER DEFAULT 0,
                stars_amount INTEGER DEFAULT 0,
                inventory_text TEXT DEFAULT NULL,
                scene_sent_at TEXT DEFAULT NULL,
                scene_source TEXT DEFAULT NULL,
                evaluated_at TEXT DEFAULT NULL,
                week_key TEXT DEFAULT NULL,
                bypass_weekly_limit INTEGER DEFAULT 0,
                rewards_json TEXT DEFAULT '{}',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                metadata_json TEXT DEFAULT NULL
            )
        `,
    }),
    Object.freeze({
        table: 'player_rolls',
        sql: `
            CREATE TABLE IF NOT EXISTS player_rolls (
                player_id TEXT NOT NULL,
                roll_number INTEGER NOT NULL,
                kingdom TEXT DEFAULT '-',
                social_class TEXT NOT NULL,
                family TEXT DEFAULT '-',
                race TEXT NOT NULL,
                grimoire TEXT NOT NULL,
                grimoire_rank TEXT DEFAULT '-',
                grimoire_symbol TEXT DEFAULT '-',
                magic_rarity TEXT NOT NULL,
                magic_scope TEXT DEFAULT '-',
                summary TEXT DEFAULT '-',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (player_id, roll_number)
            )
        `,
    }),
    Object.freeze({
        table: 'clover_item_templates',
        sql: `
            CREATE TABLE IF NOT EXISTS clover_item_templates (
                template_key TEXT PRIMARY KEY,
                catalog_version INTEGER NOT NULL DEFAULT 1,
                item_name TEXT NOT NULL,
                description TEXT DEFAULT NULL,
                category TEXT NOT NULL,
                kind TEXT NOT NULL,
                origin TEXT DEFAULT 'Clover',
                base_price INTEGER NOT NULL DEFAULT 0 CHECK (base_price >= 0),
                default_quality TEXT DEFAULT 'comum',
                default_durability INTEGER DEFAULT NULL,
                stackable INTEGER NOT NULL DEFAULT 0 CHECK (stackable IN (0, 1)),
                transferable INTEGER NOT NULL DEFAULT 1 CHECK (transferable IN (0, 1)),
                properties_json TEXT DEFAULT NULL,
                effects_json TEXT DEFAULT NULL,
                metadata_json TEXT DEFAULT NULL,
                active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
        `,
    }),
    Object.freeze({
        table: 'clover_inventory_items',
        sql: `
            CREATE TABLE IF NOT EXISTS clover_inventory_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                player_id TEXT NOT NULL,
                item_name TEXT NOT NULL,
                description TEXT DEFAULT NULL,
                quantity INTEGER DEFAULT 1 CHECK (quantity > 0),
                kind TEXT DEFAULT 'narrativo',
                source TEXT DEFAULT NULL,
                related_id TEXT DEFAULT NULL,
                created_by TEXT DEFAULT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                metadata_json TEXT DEFAULT NULL
            )
        `,
    }),
    Object.freeze({
        table: 'clover_admin_service_entries',
        sql: `
            CREATE TABLE IF NOT EXISTS clover_admin_service_entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                evaluator_id TEXT NOT NULL,
                evaluation_id INTEGER DEFAULT NULL UNIQUE,
                target_player_id TEXT DEFAULT NULL,
                modality_key TEXT NOT NULL,
                modality_label TEXT NOT NULL,
                weight INTEGER NOT NULL DEFAULT 0,
                points INTEGER NOT NULL DEFAULT 0,
                paid_points INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'partial', 'paid', 'void')),
                source TEXT NOT NULL DEFAULT 'quick_evaluation',
                service_week_key TEXT DEFAULT NULL,
                scene_week_key TEXT DEFAULT NULL,
                scene_sent_at TEXT DEFAULT NULL,
                evaluated_at TEXT DEFAULT NULL,
                created_by TEXT DEFAULT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                voided_at TEXT DEFAULT NULL,
                voided_by TEXT DEFAULT NULL,
                reason TEXT DEFAULT NULL,
                metadata_json TEXT DEFAULT NULL
            )
        `,
    }),
    Object.freeze({
        table: 'jogadores',
        sql: `
            CREATE TABLE IF NOT EXISTS jogadores (
                id TEXT PRIMARY KEY,
                nome TEXT,
                idade TEXT DEFAULT '-',
                reino TEXT DEFAULT '-',
                classe TEXT DEFAULT '-',
                familia TEXT DEFAULT '-',
                raca TEXT DEFAULT '-',
                grimorio TEXT DEFAULT '-',
                magia TEXT DEFAULT '-',
                formas TEXT DEFAULT '-',
                historia TEXT DEFAULT '-',
                aparencia TEXT DEFAULT '-',
                dinheiro INTEGER DEFAULT 0,
                esquadrao TEXT DEFAULT '-',
                estrelas INTEGER DEFAULT 0,
                atributos_max INTEGER DEFAULT 10,
                forca INTEGER DEFAULT 0,
                velocidade INTEGER DEFAULT 0,
                resistencia INTEGER DEFAULT 0,
                reflexos INTEGER DEFAULT 0,
                poder_magico INTEGER DEFAULT 0,
                mana INTEGER DEFAULT 0,
                pontos INTEGER DEFAULT 5,
                agilidade INTEGER DEFAULT 0
            )
        `,
    }),
    Object.freeze({
        table: 'clover_squads',
        sql: `
            CREATE TABLE IF NOT EXISTS clover_squads (
                squad_key TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                group_id TEXT DEFAULT NULL,
                phrase TEXT DEFAULT NULL,
                captain_name TEXT DEFAULT NULL,
                captain_player_id TEXT DEFAULT NULL,
                vice_captain_player_id TEXT DEFAULT NULL,
                historical_stars INTEGER DEFAULT 0,
                current_stars INTEGER DEFAULT 0,
                black_stars INTEGER DEFAULT 0,
                description_synced_at TEXT DEFAULT NULL,
                description_sync_status TEXT DEFAULT NULL,
                description_sync_error TEXT DEFAULT NULL,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
        `,
    }),

    Object.freeze({
        table: 'clover_raids',
        sql: `
            CREATE TABLE IF NOT EXISTS clover_raids (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                raid_key TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                category TEXT NOT NULL DEFAULT 'missao',
                description TEXT DEFAULT NULL,
                location TEXT DEFAULT 'Capital de Clover',
                status TEXT NOT NULL DEFAULT 'lobby'
                    CHECK (status IN ('lobby', 'in_progress', 'finalization', 'completed', 'cancelled')),
                owner_player_id TEXT NOT NULL,
                max_players INTEGER NOT NULL DEFAULT 12 CHECK (max_players BETWEEN 1 AND 50),
                salary_eligible INTEGER NOT NULL DEFAULT 1 CHECK (salary_eligible IN (0, 1)),
                rules_json TEXT DEFAULT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                started_at TEXT DEFAULT NULL,
                finalization_at TEXT DEFAULT NULL,
                completed_at TEXT DEFAULT NULL,
                cancelled_at TEXT DEFAULT NULL,
                cancelled_by TEXT DEFAULT NULL,
                cancellation_reason TEXT DEFAULT NULL,
                metadata_json TEXT DEFAULT NULL
            )
        `,
    }),
    Object.freeze({
        table: 'clover_raid_participants',
        sql: `
            CREATE TABLE IF NOT EXISTS clover_raid_participants (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                raid_id INTEGER NOT NULL,
                player_id TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'joined'
                    CHECK (status IN ('joined', 'active', 'completed', 'removed', 'withdrawn')),
                joined_at TEXT DEFAULT CURRENT_TIMESTAMP,
                joined_via TEXT DEFAULT 'site',
                removed_at TEXT DEFAULT NULL,
                removed_by TEXT DEFAULT NULL,
                removal_reason TEXT DEFAULT NULL,
                snapshot_json TEXT DEFAULT NULL,
                metadata_json TEXT DEFAULT NULL,
                UNIQUE (raid_id, player_id)
            )
        `,
    }),
    Object.freeze({
        table: 'clover_raid_rewards',
        sql: `
            CREATE TABLE IF NOT EXISTS clover_raid_rewards (
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
        `,
        onCreateSql: Object.freeze([
            `
                CREATE INDEX idx_clover_raid_rewards_raid
                ON clover_raid_rewards (raid_id, status, id)
            `,
        ]),
    }),
]);

async function ensureCanonicalMigratedBaseTables(db) {
    for (const entry of MIGRATED_BASE_TABLES) {
        const existed = Boolean(await db.get(
            `SELECT 1 AS found
             FROM sqlite_schema
             WHERE type = 'table' AND name = ?
             LIMIT 1`,
            [entry.table]
        ));
        await db.exec(entry.sql);
        if (!existed) {
            for (const sql of entry.onCreateSql || []) {
                await db.exec(sql);
            }
        }
    }
    return { createdOrPresent: MIGRATED_BASE_TABLES.length };
}

module.exports = {
    MIGRATED_BASE_TABLES,
    ensureCanonicalMigratedBaseTables,
};
