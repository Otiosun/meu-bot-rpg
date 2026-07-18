const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

async function ensureColumn(db, table, column, definition) {
    const columns = await db.all(`PRAGMA table_info(${table})`);
    const hasColumn = columns.some((item) => item.name === column);
    if (!hasColumn) {
        await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
}

function buildSlotReservationsSchema(tableName = 'slot_reservations') {
    return `
        CREATE TABLE IF NOT EXISTS ${tableName} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            category TEXT NOT NULL CHECK (category IN ('family', 'anomaly', 'magic', 'race', 'grimoire')),
            option_key TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'released', 'expired')),
            source TEXT DEFAULT '-',
            roll_number INTEGER DEFAULT NULL,
            expires_at TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            confirmed_at TEXT DEFAULT NULL
        )
    `;
}

async function migrateSlotReservationsCategories(db) {
    const row = await db.get(
        `SELECT sql
         FROM sqlite_master
         WHERE type = 'table' AND name = 'slot_reservations'`
    );

    if (!row?.sql) return;
    if (row.sql.includes("'race'") && row.sql.includes("'grimoire'")) return;

    await db.exec('BEGIN');
    try {
        await db.exec('ALTER TABLE slot_reservations RENAME TO slot_reservations_old_categories');
        await db.exec(buildSlotReservationsSchema('slot_reservations'));
        await db.exec(`
            INSERT INTO slot_reservations
            (id, player_id, category, option_key, status, source, roll_number, expires_at, created_at, confirmed_at)
            SELECT id, player_id, category, option_key, status, source, roll_number, expires_at, created_at, confirmed_at
            FROM slot_reservations_old_categories
        `);
        await db.exec('DROP TABLE slot_reservations_old_categories');
        await db.exec('COMMIT');
    } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
    }
}

async function ensureSlotReservationsSchema(db) {
    await db.exec(buildSlotReservationsSchema('slot_reservations'));
    await migrateSlotReservationsCategories(db);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_slot_reservations_option_status
        ON slot_reservations (category, option_key, status)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_slot_reservations_player_category_status
        ON slot_reservations (player_id, category, status)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_slot_reservations_expires_at
        ON slot_reservations (expires_at)
    `);
}

async function ensureCloverTraitAttemptsSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_trait_attempts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            attempt_number INTEGER NOT NULL,
            category TEXT NOT NULL CHECK (category IN ('rare_aptitude', 'rare_mark', 'anomaly')),
            status TEXT NOT NULL DEFAULT 'completed',
            result TEXT NOT NULL CHECK (result IN ('success', 'failure')),
            chosen_key TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (player_id, attempt_number)
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_trait_attempts_player
        ON clover_trait_attempts (player_id)
    `);
}

async function ensureCloverSettingsSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);
}

function pad2(value) {
    return String(value).padStart(2, '0');
}

function formatLocalDateKey(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function parseSqliteTimestamp(value) {
    const text = String(value || '').trim();
    if (!text) return new Date();

    const dateOnly = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dateOnly) {
        return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 12, 0, 0);
    }

    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(text)) {
        const [datePart, timePart] = text.split(' ');
        const [year, month, day] = datePart.split('-').map(Number);
        const [hour, minute, second = 0] = timePart.split(':').map(Number);
        return new Date(year, month - 1, day, hour, minute, second);
    }

    return new Date(text.replace(' ', 'T'));
}

function getMondayWeekKey(date = new Date()) {
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    const daysSinceMonday = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - daysSinceMonday);
    return formatLocalDateKey(start);
}

async function normalizeQuickEvaluationWeekKeys(db) {
    const settingKey = 'quick_evaluation_week_key_rule';
    const settingValue = 'monday_scene_v2';
    await ensureCloverSettingsSchema(db);

    const current = await db.get('SELECT value FROM clover_settings WHERE key = ?', [settingKey]);
    if (current?.value === settingValue) return;

    const rows = await db.all('SELECT id, scene_sent_at, created_at, week_key FROM clover_quick_evaluations');

    await db.exec('BEGIN');
    try {
        for (const row of rows) {
            const baseDate = row.scene_sent_at || row.created_at;
            const expectedWeekKey = getMondayWeekKey(parseSqliteTimestamp(baseDate));
            if (expectedWeekKey !== row.week_key) {
                await db.run(
                    'UPDATE clover_quick_evaluations SET week_key = ? WHERE id = ?',
                    [expectedWeekKey, row.id]
                );
            }
        }

        await db.run(
            `INSERT INTO clover_settings (key, value, updated_at)
             VALUES (?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(key) DO UPDATE SET
                 value = excluded.value,
                 updated_at = CURRENT_TIMESTAMP`,
            [settingKey, settingValue]
        );

        await db.exec('COMMIT');
    } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
    }
}

async function ensureCloverArchiveCardsSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_archive_cards (
            player_id TEXT PRIMARY KEY,
            group_id TEXT NOT NULL,
            message_key_json TEXT NOT NULL,
            snapshot_hash TEXT NOT NULL,
            snapshot_json TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'deleted')),
            last_sent_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_archive_cards_group
        ON clover_archive_cards (group_id, updated_at DESC)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_archive_cards_status
        ON clover_archive_cards (status)
    `);
}

async function ensureCloverAppearanceReviewSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_appearance_reviews (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            group_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            scope TEXT NOT NULL CHECK (scope IN ('reception', 'registration')),
            appearance TEXT NOT NULL,
            appearance_normalized TEXT DEFAULT NULL,
            has_image INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (group_id, message_id)
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_appearance_reviews_message
        ON clover_appearance_reviews (group_id, message_id)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_appearance_reviews_player
        ON clover_appearance_reviews (player_id)
    `);
}

async function ensureCloverCharacterStatsSchema(db) {
    await db.exec(`
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
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_character_stats_player
        ON clover_character_stats (player_id)
    `);

    await ensureColumn(db, 'clover_character_stats', 'ph_accumulated', 'INTEGER DEFAULT 0');
    await ensureColumn(db, 'clover_character_stats', 'ph_available', 'INTEGER DEFAULT 0');
}

async function ensureCloverPhLedgerSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_ph_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            amount INTEGER NOT NULL CHECK (amount != 0),
            kind TEXT NOT NULL CHECK (kind IN ('ganho', 'gasto', 'perda', 'ajuste_admin', 'estorno')),
            source TEXT DEFAULT NULL,
            reason TEXT DEFAULT NULL,
            related_id TEXT DEFAULT NULL,
            created_by TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_ph_ledger_player_created
        ON clover_ph_ledger (player_id, created_at DESC, id DESC)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_ph_ledger_kind
        ON clover_ph_ledger (kind)
    `);
}

async function ensureCloverYullsLedgerSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_yulls_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            amount INTEGER NOT NULL,
            balance_before INTEGER NOT NULL CHECK (balance_before >= 0),
            balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
            kind TEXT NOT NULL CHECK (kind IN (
                'saldo_inicial',
                'ganho',
                'gasto',
                'ajuste_admin',
                'estorno',
                'sincronizacao_legada'
            )),
            source TEXT DEFAULT NULL,
            reason TEXT DEFAULT NULL,
            related_id TEXT DEFAULT NULL,
            idempotency_key TEXT DEFAULT NULL UNIQUE,
            created_by TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL,
            CHECK (amount != 0 OR kind = 'saldo_inicial'),
            CHECK (balance_after = balance_before + amount)
        )
    `);

    await db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_clover_yulls_opening_once
        ON clover_yulls_ledger (player_id)
        WHERE kind = 'saldo_inicial'
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_yulls_player_created
        ON clover_yulls_ledger (player_id, created_at DESC, id DESC)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_yulls_source_related
        ON clover_yulls_ledger (source, related_id)
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_yulls_reservations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            reservation_key TEXT NOT NULL UNIQUE,
            player_id TEXT NOT NULL,
            amount INTEGER NOT NULL CHECK (amount > 0),
            source_type TEXT NOT NULL,
            source_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'released', 'consumed', 'expired')),
            created_by TEXT DEFAULT NULL,
            expires_at TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            released_at TEXT DEFAULT NULL,
            metadata_json TEXT DEFAULT NULL
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_yulls_reservations_player
        ON clover_yulls_reservations (player_id, status, expires_at, id)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_yulls_reservations_source
        ON clover_yulls_reservations (source_type, source_id, status, id)
    `);
}

async function ensureCloverRecruitmentSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_recruitment_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_key TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'active', 'paused', 'ended')),
            starts_at TEXT DEFAULT NULL,
            ends_at TEXT DEFAULT NULL,
            duration_days INTEGER NOT NULL DEFAULT 30 CHECK (duration_days > 0),
            referral_window_days INTEGER NOT NULL DEFAULT 7 CHECK (referral_window_days > 0),
            recruiter_pr_reward INTEGER NOT NULL DEFAULT 5 CHECK (recruiter_pr_reward >= 0),
            group_weekly_pr_limit INTEGER NOT NULL DEFAULT 20 CHECK (group_weekly_pr_limit >= 0),
            recruit_yulls_reward INTEGER NOT NULL DEFAULT 10000 CHECK (recruit_yulls_reward >= 0),
            recruit_ph_reward INTEGER NOT NULL DEFAULT 30 CHECK (recruit_ph_reward >= 0),
            recruit_item_reward TEXT DEFAULT 'Caixa Simples',
            recruit_item_quantity INTEGER NOT NULL DEFAULT 1 CHECK (recruit_item_quantity >= 0),
            shop_enabled INTEGER NOT NULL DEFAULT 0 CHECK (shop_enabled IN (0, 1)),
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL
        )
    `);

    await db.run(`
        INSERT OR IGNORE INTO clover_recruitment_events (
            event_key,
            name,
            status,
            duration_days,
            referral_window_days,
            recruiter_pr_reward,
            group_weekly_pr_limit,
            recruit_yulls_reward,
            recruit_ph_reward,
            recruit_item_reward,
            recruit_item_quantity,
            shop_enabled
        ) VALUES ('divulgacao_v1', 'Evento de Divulgação', 'draft', 30, 7, 5, 20, 10000, 30, 'Caixa Simples', 1, 0)
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_pr_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            event_id INTEGER DEFAULT NULL,
            amount INTEGER NOT NULL CHECK (amount != 0),
            kind TEXT NOT NULL CHECK (kind IN ('ganho', 'gasto', 'ajuste_admin', 'estorno')),
            source TEXT NOT NULL CHECK (source IN (
                'recrutamento',
                'divulgacao_grupo',
                'loja',
                'ajuste_admin',
                'estorno'
            )),
            week_key TEXT DEFAULT NULL,
            reason TEXT DEFAULT NULL,
            related_id TEXT DEFAULT NULL,
            idempotency_key TEXT DEFAULT NULL UNIQUE,
            created_by TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL,
            FOREIGN KEY (event_id) REFERENCES clover_recruitment_events(id)
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_pr_player_created
        ON clover_pr_ledger (player_id, created_at DESC, id DESC)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_pr_group_week
        ON clover_pr_ledger (player_id, event_id, source, week_key)
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_recruitment_codes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL UNIQUE,
            code TEXT NOT NULL COLLATE NOCASE UNIQUE,
            active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_recruitment_referrals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id INTEGER NOT NULL,
            recruit_player_id TEXT NOT NULL,
            recruiter_player_id TEXT NOT NULL,
            recruitment_code TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'validated', 'rewarded', 'cancelled', 'expired')),
            submitted_at TEXT DEFAULT CURRENT_TIMESTAMP,
            deadline_at TEXT NOT NULL,
            validation_source TEXT DEFAULT NULL,
            validation_evaluation_id INTEGER DEFAULT NULL,
            validated_at TEXT DEFAULT NULL,
            rewarded_at TEXT DEFAULT NULL,
            cancelled_at TEXT DEFAULT NULL,
            cancellation_reason TEXT DEFAULT NULL,
            created_by TEXT DEFAULT NULL,
            metadata_json TEXT DEFAULT NULL,
            UNIQUE (event_id, recruit_player_id),
            FOREIGN KEY (event_id) REFERENCES clover_recruitment_events(id)
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_referrals_recruiter_status
        ON clover_recruitment_referrals (recruiter_player_id, event_id, status)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_referrals_pending
        ON clover_recruitment_referrals (status, deadline_at)
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_recruitment_reward_deliveries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            referral_id INTEGER NOT NULL UNIQUE,
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
            yulls_ledger_id INTEGER DEFAULT NULL,
            ph_ledger_id INTEGER DEFAULT NULL,
            inventory_item_id INTEGER DEFAULT NULL,
            attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
            last_error TEXT DEFAULT NULL,
            completed_at TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (referral_id) REFERENCES clover_recruitment_referrals(id)
        )
    `);
}

async function ensureCloverInventorySchema(db) {
    await db.exec(`
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
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_inventory_items_player
        ON clover_inventory_items (player_id, created_at DESC, id DESC)
    `);

    await ensureColumn(db, 'clover_inventory_items', 'template_key', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'clover_inventory_items', 'catalog_version', 'INTEGER DEFAULT 1');
    await ensureColumn(db, 'clover_inventory_items', 'category', "TEXT DEFAULT 'material'");
    await ensureColumn(db, 'clover_inventory_items', 'origin', "TEXT DEFAULT 'Clover'");
    await ensureColumn(db, 'clover_inventory_items', 'status', "TEXT DEFAULT 'disponivel'");
    await ensureColumn(db, 'clover_inventory_items', 'quality', "TEXT DEFAULT 'comum'");
    await ensureColumn(db, 'clover_inventory_items', 'base_price', 'INTEGER DEFAULT 0');
    await ensureColumn(db, 'clover_inventory_items', 'reference_price', 'INTEGER DEFAULT 0');
    await ensureColumn(db, 'clover_inventory_items', 'durability_current', 'INTEGER DEFAULT NULL');
    await ensureColumn(db, 'clover_inventory_items', 'durability_max', 'INTEGER DEFAULT NULL');
    await ensureColumn(db, 'clover_inventory_items', 'bound', 'INTEGER DEFAULT 0');
    await ensureColumn(db, 'clover_inventory_items', 'transferable', 'INTEGER DEFAULT 1');
    await ensureColumn(db, 'clover_inventory_items', 'equipped_slot', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'clover_inventory_items', 'expires_at', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'clover_inventory_items', 'updated_at', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'clover_inventory_items', 'properties_json', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'clover_inventory_items', 'effects_json', 'TEXT DEFAULT NULL');

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_inventory_template_status
        ON clover_inventory_items (player_id, template_key, status)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_inventory_equipped_slot
        ON clover_inventory_items (player_id, equipped_slot)
        WHERE equipped_slot IS NOT NULL
    `);

    await db.exec(`
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
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_inventory_item_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            item_id INTEGER DEFAULT NULL,
            player_id TEXT NOT NULL,
            action TEXT NOT NULL,
            quantity_delta INTEGER DEFAULT 0,
            durability_delta INTEGER DEFAULT 0,
            before_json TEXT DEFAULT NULL,
            after_json TEXT DEFAULT NULL,
            source TEXT DEFAULT NULL,
            related_id TEXT DEFAULT NULL,
            idempotency_key TEXT DEFAULT NULL UNIQUE,
            created_by TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_inventory_history_item
        ON clover_inventory_item_history (item_id, created_at DESC, id DESC)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_inventory_history_player
        ON clover_inventory_item_history (player_id, created_at DESC, id DESC)
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_box_openings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            inventory_item_id INTEGER DEFAULT NULL,
            box_key TEXT NOT NULL,
            catalog_version INTEGER NOT NULL,
            roll INTEGER NOT NULL CHECK (roll BETWEEN 1 AND 100),
            reward_key TEXT NOT NULL,
            result_json TEXT DEFAULT NULL,
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'completed', 'failed')),
            idempotency_key TEXT NOT NULL UNIQUE,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            completed_at TEXT DEFAULT NULL,
            metadata_json TEXT DEFAULT NULL
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_box_openings_player
        ON clover_box_openings (player_id, created_at DESC, id DESC)
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_player_titles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            title_key TEXT NOT NULL,
            title_name TEXT NOT NULL,
            source TEXT DEFAULT NULL,
            related_id TEXT DEFAULT NULL,
            active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
            unlocked_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL,
            UNIQUE (player_id, title_key)
        )
    `);

    await db.exec(`
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
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_inventory_reservations_item
        ON clover_inventory_reservations (inventory_item_id, status, id)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_inventory_reservations_source
        ON clover_inventory_reservations (source_type, source_id, status, id)
    `);

    await ensureColumn(db, 'clover_inventory_reservations', 'expires_at', 'TEXT DEFAULT NULL');

    await db.run(`
        UPDATE clover_inventory_items
        SET category = CASE
                WHEN kind LIKE 'caixa%' THEN 'caixa'
                WHEN kind LIKE 'cupom%' OR kind LIKE 'consumivel%' THEN 'consumivel'
                WHEN kind = 'titulo' THEN 'titulo'
                ELSE COALESCE(NULLIF(category, ''), 'material')
            END,
            status = COALESCE(NULLIF(status, ''), 'disponivel'),
            quality = COALESCE(NULLIF(quality, ''), 'comum'),
            reference_price = COALESCE(reference_price, base_price, 0),
            updated_at = COALESCE(updated_at, created_at, CURRENT_TIMESTAMP)
        WHERE template_key IS NULL
    `);
}

async function ensureCloverEconomySchema(db) {
    await ensureCloverYullsLedgerSchema(db);
    await ensureCloverInventorySchema(db);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_economy_shops (
            shop_key TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT DEFAULT NULL,
            active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
            display_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL
        )
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_economy_listings (
            listing_key TEXT PRIMARY KEY,
            shop_key TEXT NOT NULL,
            template_key TEXT NOT NULL,
            quality TEXT NOT NULL DEFAULT 'comum',
            availability TEXT NOT NULL DEFAULT 'comum'
                CHECK (availability IN ('comum', 'regional', 'exclusivo', 'restrito')),
            unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
            delivery_minutes INTEGER NOT NULL DEFAULT 0 CHECK (delivery_minutes >= 0),
            regional_fee_percent INTEGER NOT NULL DEFAULT 0 CHECK (regional_fee_percent >= 0),
            personal_weekly_limit INTEGER DEFAULT NULL,
            global_stock INTEGER DEFAULT NULL,
            sold_quantity INTEGER NOT NULL DEFAULT 0 CHECK (sold_quantity >= 0),
            active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
            display_order INTEGER NOT NULL DEFAULT 0,
            starts_at TEXT DEFAULT NULL,
            ends_at TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL,
            FOREIGN KEY (shop_key) REFERENCES clover_economy_shops(shop_key),
            FOREIGN KEY (template_key) REFERENCES clover_item_templates(template_key)
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_economy_listings_shop
        ON clover_economy_listings (shop_key, active, display_order, listing_key)
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_economy_purchase_intents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            intent_key TEXT NOT NULL UNIQUE,
            player_id TEXT NOT NULL,
            listing_key TEXT NOT NULL,
            quantity INTEGER NOT NULL CHECK (quantity > 0),
            unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
            subtotal INTEGER NOT NULL CHECK (subtotal >= 0),
            regional_fee INTEGER NOT NULL DEFAULT 0 CHECK (regional_fee >= 0),
            express_fee INTEGER NOT NULL DEFAULT 0 CHECK (express_fee >= 0),
            discount INTEGER NOT NULL DEFAULT 0 CHECK (discount >= 0),
            total INTEGER NOT NULL CHECK (total >= 0),
            express INTEGER NOT NULL DEFAULT 0 CHECK (express IN (0, 1)),
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'confirmed', 'in_transport', 'completed', 'cancelled', 'expired', 'refunded')),
            yulls_reservation_id INTEGER DEFAULT NULL,
            voucher_item_id INTEGER DEFAULT NULL,
            voucher_reservation_id INTEGER DEFAULT NULL,
            inventory_item_ids_json TEXT DEFAULT '[]',
            idempotency_key TEXT DEFAULT NULL UNIQUE,
            expires_at TEXT NOT NULL,
            deliver_at TEXT DEFAULT NULL,
            confirmed_at TEXT DEFAULT NULL,
            completed_at TEXT DEFAULT NULL,
            cancelled_at TEXT DEFAULT NULL,
            refunded_at TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL,
            FOREIGN KEY (listing_key) REFERENCES clover_economy_listings(listing_key)
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_purchase_intents_player
        ON clover_economy_purchase_intents (player_id, status, created_at DESC, id DESC)
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_economy_sale_intents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            intent_key TEXT NOT NULL UNIQUE,
            player_id TEXT NOT NULL,
            inventory_item_id INTEGER NOT NULL,
            quantity INTEGER NOT NULL CHECK (quantity > 0),
            reference_price INTEGER NOT NULL CHECK (reference_price >= 0),
            offer_percent INTEGER NOT NULL CHECK (offer_percent >= 0),
            offer_total INTEGER NOT NULL CHECK (offer_total >= 0),
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'confirmed', 'cancelled', 'expired')),
            inventory_reservation_id INTEGER DEFAULT NULL,
            idempotency_key TEXT DEFAULT NULL UNIQUE,
            expires_at TEXT NOT NULL,
            confirmed_at TEXT DEFAULT NULL,
            cancelled_at TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_sale_intents_player
        ON clover_economy_sale_intents (player_id, status, created_at DESC, id DESC)
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_repair_orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_key TEXT NOT NULL UNIQUE,
            player_id TEXT NOT NULL,
            inventory_item_id INTEGER NOT NULL,
            points INTEGER NOT NULL CHECK (points > 0),
            point_cost INTEGER NOT NULL CHECK (point_cost >= 0),
            broken_surcharge INTEGER NOT NULL DEFAULT 0 CHECK (broken_surcharge >= 0),
            discount INTEGER NOT NULL DEFAULT 0 CHECK (discount >= 0),
            total INTEGER NOT NULL CHECK (total >= 0),
            express INTEGER NOT NULL DEFAULT 0 CHECK (express IN (0, 1)),
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled', 'expired')),
            yulls_reservation_id INTEGER DEFAULT NULL,
            inventory_reservation_id INTEGER DEFAULT NULL,
            voucher_item_id INTEGER DEFAULT NULL,
            voucher_reservation_id INTEGER DEFAULT NULL,
            idempotency_key TEXT DEFAULT NULL UNIQUE,
            expires_at TEXT NOT NULL,
            deliver_at TEXT DEFAULT NULL,
            confirmed_at TEXT DEFAULT NULL,
            completed_at TEXT DEFAULT NULL,
            cancelled_at TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_repair_orders_player
        ON clover_repair_orders (player_id, status, created_at DESC, id DESC)
    `);

    await db.exec(`
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
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_consumable_uses_player
        ON clover_consumable_uses (player_id, used_at DESC, id DESC)
    `);

    await ensureColumn(db, 'clover_consumable_uses', 'effect_category', 'TEXT DEFAULT NULL');

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_active_item_effects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            inventory_item_id INTEGER DEFAULT NULL,
            template_key TEXT DEFAULT NULL,
            effect_key TEXT NOT NULL,
            effect_category TEXT DEFAULT NULL,
            context_type TEXT NOT NULL DEFAULT 'livre',
            context_id TEXT DEFAULT NULL,
            status TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'replaced', 'resolved', 'expired')),
            started_at TEXT DEFAULT CURRENT_TIMESTAMP,
            ended_at TEXT DEFAULT NULL,
            metadata_json TEXT DEFAULT NULL
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_active_item_effects_player
        ON clover_active_item_effects (player_id, status, context_type, context_id, id DESC)
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_salary_claims (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            week_key TEXT NOT NULL,
            patent TEXT NOT NULL,
            amount INTEGER NOT NULL CHECK (amount >= 0),
            service_source TEXT NOT NULL,
            service_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid', 'reversed')),
            yulls_ledger_id INTEGER DEFAULT NULL,
            paid_at TEXT DEFAULT CURRENT_TIMESTAMP,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL,
            UNIQUE (player_id, week_key)
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_salary_claims_week
        ON clover_salary_claims (week_key, status, player_id)
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_economy_initial_packages (
            player_id TEXT PRIMARY KEY,
            equipment_template_key TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'reversed')),
            yulls_ledger_id INTEGER DEFAULT NULL,
            inventory_item_ids_json TEXT DEFAULT '[]',
            granted_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL
        )
    `);
}

async function ensureCloverRaidSchema(db) {
    await ensureCloverInventorySchema(db);

    await db.exec(`
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
    `);

    await ensureColumn(db, 'clover_raids', 'salary_eligible', 'INTEGER NOT NULL DEFAULT 1');

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_raids_status
        ON clover_raids (status, created_at DESC, id DESC)
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_raid_hosts (
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
    `);

    await db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_clover_raid_hosts_active
        ON clover_raid_hosts (raid_id, player_id)
        WHERE status = 'active'
    `);

    await db.exec(`
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
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_raid_participants_player
        ON clover_raid_participants (player_id, status, joined_at DESC, id DESC)
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_raid_loadout_items (
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
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_raid_loadout_participant
        ON clover_raid_loadout_items (participant_id, slot_key, id)
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_raid_item_events (
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
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_raid_item_events_raid
        ON clover_raid_item_events (raid_id, created_at DESC, id DESC)
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_raid_conditions (
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
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_raid_conditions_raid
        ON clover_raid_conditions (raid_id, status, applied_at DESC, id DESC)
    `);

    await db.exec(`
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
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_raid_rewards_raid
        ON clover_raid_rewards (raid_id, status, id)
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_raid_reward_deliveries (
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
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_raid_reward_deliveries_player
        ON clover_raid_reward_deliveries (player_id, created_at DESC, id DESC)
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_raid_events (
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
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_raid_events_raid
        ON clover_raid_events (raid_id, created_at DESC, id DESC)
    `);
}

async function ensureCloverQuickEvaluationsSchema(db) {
    await db.exec(`
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
    `);

    await ensureColumn(db, 'clover_quick_evaluations', 'quoted_message_key', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'clover_quick_evaluations', 'scene_sent_at', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'clover_quick_evaluations', 'scene_source', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'clover_quick_evaluations', 'evaluated_at', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'clover_quick_evaluations', 'salary_eligible', 'INTEGER DEFAULT NULL');
    await ensureColumn(db, 'clover_quick_evaluations', 'salary_service_type', 'TEXT DEFAULT NULL');

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_quick_evaluations_player_week
        ON clover_quick_evaluations (player_id, week_key, bypass_weekly_limit)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_quick_evaluations_scene
        ON clover_quick_evaluations (scene_sent_at, scene_source)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_quick_evaluations_evaluator
        ON clover_quick_evaluations (evaluator_id, created_at DESC)
    `);

    await db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_clover_quick_evaluations_quoted_message
        ON clover_quick_evaluations (quoted_message_key)
        WHERE quoted_message_key IS NOT NULL
    `);

    await normalizeQuickEvaluationWeekKeys(db);
}

async function ensureCloverSquadSchema(db) {
    await db.exec(`
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
    `);

    await ensureColumn(db, 'clover_squads', 'group_id', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'clover_squads', 'phrase', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'clover_squads', 'captain_name', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'clover_squads', 'captain_player_id', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'clover_squads', 'vice_captain_player_id', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'clover_squads', 'description_synced_at', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'clover_squads', 'description_sync_status', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'clover_squads', 'description_sync_error', 'TEXT DEFAULT NULL');

    await db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_clover_squads_group
        ON clover_squads (group_id)
        WHERE group_id IS NOT NULL
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_squad_star_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            squad_key TEXT NOT NULL,
            player_id TEXT DEFAULT NULL,
            evaluation_id INTEGER DEFAULT NULL,
            amount INTEGER NOT NULL CHECK (amount != 0),
            kind TEXT NOT NULL DEFAULT 'ganho',
            source TEXT DEFAULT NULL,
            reason TEXT DEFAULT NULL,
            created_by TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_squad_star_ledger_squad
        ON clover_squad_star_ledger (squad_key, created_at DESC, id DESC)
    `);
}

async function ensureCloverSkillTreeSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_skill_nodes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            tree_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            purchased_at TEXT DEFAULT CURRENT_TIMESTAMP,
            purchased_by TEXT DEFAULT NULL,
            source TEXT DEFAULT NULL,
            metadata_json TEXT DEFAULT NULL,
            UNIQUE (player_id, tree_id, node_id)
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_skill_nodes_player_tree
        ON clover_skill_nodes (player_id, tree_id)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_skill_nodes_tree_node
        ON clover_skill_nodes (tree_id, node_id)
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_pending_skill_purchases (
            player_id TEXT PRIMARY KEY,
            tree_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            created_by TEXT DEFAULT NULL,
            source TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            expires_at TEXT DEFAULT NULL,
            metadata_json TEXT DEFAULT NULL
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_pending_skill_purchases_expires
        ON clover_pending_skill_purchases (expires_at)
    `);
}

async function ensureCloverManaHexagonSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_mana_hexagon (
            player_id TEXT PRIMARY KEY,
            percepcao INTEGER DEFAULT 1 CHECK (percepcao BETWEEN 1 AND 5),
            retencao INTEGER DEFAULT 1 CHECK (retencao BETWEEN 1 AND 5),
            emissao INTEGER DEFAULT 1 CHECK (emissao BETWEEN 1 AND 5),
            controle INTEGER DEFAULT 1 CHECK (controle BETWEEN 1 AND 5),
            pressao INTEGER DEFAULT 1 CHECK (pressao BETWEEN 1 AND 5),
            alcance INTEGER DEFAULT 1 CHECK (alcance BETWEEN 1 AND 5),
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_by TEXT DEFAULT NULL
        )
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_mana_hexagon_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            side TEXT NOT NULL CHECK (side IN ('percepcao', 'retencao', 'emissao', 'controle', 'pressao', 'alcance')),
            old_value INTEGER CHECK (old_value BETWEEN 1 AND 5),
            new_value INTEGER NOT NULL CHECK (new_value BETWEEN 1 AND 5),
            reason TEXT DEFAULT NULL,
            created_by TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_pending_hexagon_upgrades (
            player_id TEXT PRIMARY KEY,
            side TEXT NOT NULL CHECK (side IN ('percepcao', 'retencao', 'emissao', 'controle', 'pressao', 'alcance')),
            old_value INTEGER NOT NULL CHECK (old_value BETWEEN 1 AND 5),
            new_value INTEGER NOT NULL CHECK (new_value BETWEEN 1 AND 5),
            cost INTEGER NOT NULL,
            requires_approval INTEGER DEFAULT 0,
            created_by TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            expires_at TEXT DEFAULT NULL,
            metadata_json TEXT DEFAULT NULL
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_mana_hexagon_ledger_player
        ON clover_mana_hexagon_ledger (player_id, created_at DESC, id DESC)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_mana_hexagon_ledger_side
        ON clover_mana_hexagon_ledger (side)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_pending_hexagon_upgrades_expires
        ON clover_pending_hexagon_upgrades (expires_at)
    `);
}

async function ensureCloverSiteAuthSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_site_login_codes (
            player_id TEXT PRIMARY KEY,
            phone_digits TEXT DEFAULT NULL,
            code_hash TEXT NOT NULL,
            code_salt TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            expires_at TEXT NOT NULL,
            used_at TEXT DEFAULT NULL
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_site_login_codes_phone
        ON clover_site_login_codes (phone_digits, expires_at)
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_site_sessions (
            token_hash TEXT PRIMARY KEY,
            player_id TEXT NOT NULL,
            phone_digits TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            expires_at TEXT NOT NULL,
            last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
            revoked_at TEXT DEFAULT NULL
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_site_sessions_player
        ON clover_site_sessions (player_id, expires_at)
    `);
}

async function ensureCloverAdminServiceSchema(db) {
    await db.exec(`
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
    `);

    await ensureColumn(db, 'clover_admin_service_entries', 'target_player_id', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'clover_admin_service_entries', 'evaluation_id', 'INTEGER DEFAULT NULL');
    await ensureColumn(db, 'clover_admin_service_entries', 'paid_points', 'INTEGER NOT NULL DEFAULT 0');
    await ensureColumn(db, 'clover_admin_service_entries', 'status', "TEXT NOT NULL DEFAULT 'pending'");
    await ensureColumn(db, 'clover_admin_service_entries', 'service_week_key', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'clover_admin_service_entries', 'scene_week_key', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'clover_admin_service_entries', 'scene_sent_at', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'clover_admin_service_entries', 'evaluated_at', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'clover_admin_service_entries', 'created_by', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'clover_admin_service_entries', 'voided_at', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'clover_admin_service_entries', 'voided_by', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'clover_admin_service_entries', 'reason', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'clover_admin_service_entries', 'metadata_json', 'TEXT DEFAULT NULL');

    await db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_clover_admin_service_evaluation
        ON clover_admin_service_entries (evaluation_id)
        WHERE evaluation_id IS NOT NULL
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_admin_service_evaluator_status
        ON clover_admin_service_entries (evaluator_id, status, created_at DESC)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_admin_service_week
        ON clover_admin_service_entries (service_week_key, evaluator_id)
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_admin_service_payouts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            evaluator_id TEXT NOT NULL,
            player_id TEXT DEFAULT NULL,
            points_paid INTEGER NOT NULL DEFAULT 0,
            ph_paid INTEGER NOT NULL DEFAULT 0,
            week_key TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'servico_adm',
            reason TEXT DEFAULT NULL,
            created_by TEXT DEFAULT NULL,
            ledger_id INTEGER DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_admin_service_payouts_evaluator
        ON clover_admin_service_payouts (evaluator_id, created_at DESC)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_admin_service_payouts_week
        ON clover_admin_service_payouts (week_key, player_id)
    `);
}

async function criarBanco() {
    const db = await open({ filename: './banco.sqlite', driver: sqlite3.Database });
    db.configure?.('busyTimeout', 10000);
    await db.exec(`
        PRAGMA busy_timeout = 10000;
        PRAGMA journal_mode = WAL;
    `);
    
    await db.exec(`
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
    `);

    await ensureColumn(db, 'jogadores', 'display_name', "TEXT DEFAULT '-'");
    await ensureColumn(db, 'jogadores', 'nome_real', "TEXT DEFAULT '-'");
    await ensureColumn(db, 'jogadores', 'idade_real', 'INTEGER DEFAULT NULL');
    await ensureColumn(db, 'jogadores', 'gosta_de_fazer', "TEXT DEFAULT '-'");
    await ensureColumn(db, 'jogadores', 'disponibilidade_detalhada', "TEXT DEFAULT '-'");
    await ensureColumn(db, 'jogadores', 'personagem_nome', "TEXT DEFAULT '-'");
    await ensureColumn(db, 'jogadores', 'personagem_idade', 'INTEGER DEFAULT NULL');
    await ensureColumn(db, 'jogadores', 'personagem_aparencia', "TEXT DEFAULT '-'");
    await ensureColumn(db, 'jogadores', 'personagem_aparencia_normalizada', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'jogadores', 'personagem_aparencia_status', "TEXT DEFAULT 'pending'");
    await ensureColumn(db, 'jogadores', 'personagem_aparencia_motivo', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'jogadores', 'personagem_aparencia_image_path', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'jogadores', 'personagem_aparencia_image_message_id', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'jogadores', 'personagem_aparencia_approved_by', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'jogadores', 'personagem_aparencia_approved_at', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'jogadores', 'personagem_aparencia_updated_at', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'jogadores', 'personagem_genero', "TEXT DEFAULT '-'");
    await ensureColumn(db, 'jogadores', 'numero_roll_escolhido', 'INTEGER DEFAULT NULL');
    await ensureColumn(db, 'jogadores', 'ficha_status', "TEXT DEFAULT 'incompleta'");
    await ensureColumn(db, 'jogadores', 'ultima_recepcao_em', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'jogadores', 'familia_key', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'jogadores', 'magia_key', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'jogadores', 'aptidao_comum', "TEXT DEFAULT '-'");
    await ensureColumn(db, 'jogadores', 'aptidao_comum_key', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'jogadores', 'marca_comum', "TEXT DEFAULT '-'");
    await ensureColumn(db, 'jogadores', 'marca_comum_key', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'jogadores', 'aptidao_rara', "TEXT DEFAULT '-'");
    await ensureColumn(db, 'jogadores', 'aptidao_rara_key', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'jogadores', 'marca_rara', "TEXT DEFAULT '-'");
    await ensureColumn(db, 'jogadores', 'marca_rara_key', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'jogadores', 'anomalia', "TEXT DEFAULT '-'");
    await ensureColumn(db, 'jogadores', 'anomalia_key', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'jogadores', 'tentativas_especiais', "TEXT DEFAULT '[]'");
    await ensureColumn(db, 'jogadores', 'roll_sacrifice_used', 'INTEGER DEFAULT 0');
    await ensureColumn(db, 'jogadores', 'roll_sacrifice_used_at', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'jogadores', 'historia_status', "TEXT DEFAULT 'pendente'");
    await ensureColumn(db, 'jogadores', 'historia_status_updated_at', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'jogadores', 'historia_aprovada_at', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'jogadores', 'historia_aprovada_by', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'jogadores', 'historia_pv_sent_at', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'jogadores', 'historia_motivo', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'jogadores', 'gancho_narrativo', "TEXT DEFAULT '-'");
    await ensureColumn(db, 'jogadores', 'historias_extras', "TEXT DEFAULT '[]'");
    await ensureColumn(db, 'jogadores', 'jogo_status', "TEXT DEFAULT 'bloqueado'");
    await ensureColumn(db, 'jogadores', 'jogo_liberado_at', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'jogadores', 'jogo_liberado_by', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'jogadores', 'jogo_bloqueio_motivo', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'jogadores', 'patente', "TEXT DEFAULT '-'");

    await db.exec(`
        CREATE TABLE IF NOT EXISTS player_progress (
            player_id TEXT PRIMARY KEY,
            ph_total INTEGER DEFAULT 0,
            ph_bonus INTEGER DEFAULT 0,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS player_skill_trees (
            player_id TEXT NOT NULL,
            tree TEXT NOT NULL,
            ph_spent INTEGER DEFAULT 0,
            unlocked_node_ids TEXT DEFAULT '[]',
            narrative_flags TEXT DEFAULT '[]',
            last_purchase TEXT DEFAULT NULL,
            last_prox_options TEXT DEFAULT '[]',
            purchase_history TEXT DEFAULT '[]',
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (player_id, tree)
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_player_skill_trees_tree
        ON player_skill_trees (tree)
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS player_onboarding (
            player_id TEXT PRIMARY KEY,
            started_at TEXT DEFAULT CURRENT_TIMESTAMP,
            welcome_sent_at TEXT DEFAULT CURRENT_TIMESTAMP,
            last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
            current_step TEXT DEFAULT 'inicio'
        )
    `);

    await ensureColumn(db, 'player_onboarding', 'step_payload', "TEXT DEFAULT '{}'");

    await db.exec(`
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
    `);

    await ensureColumn(db, 'player_rolls', 'kingdom', "TEXT DEFAULT '-'");
    await ensureColumn(db, 'player_rolls', 'grimoire_rank', "TEXT DEFAULT '-'");
    await ensureColumn(db, 'player_rolls', 'grimoire_symbol', "TEXT DEFAULT '-'");
    await ensureColumn(db, 'player_rolls', 'magic_scope', "TEXT DEFAULT '-'");
    await ensureColumn(db, 'player_rolls', 'roll_version', "TEXT DEFAULT 'legacy'");
    await ensureColumn(db, 'player_rolls', 'kingdom_key', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'player_rolls', 'social_class_key', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'player_rolls', 'race_key', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'player_rolls', 'grimoire_key', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'player_rolls', 'magic_rarity_key', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'player_rolls', 'roll_payload', "TEXT DEFAULT '{}'");

    await db.exec(`
        CREATE TABLE IF NOT EXISTS pending_profile_confirmations (
            player_id TEXT PRIMARY KEY,
            payload TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS pending_magic_confirmations (
            player_id TEXT PRIMARY KEY,
            magic_label TEXT NOT NULL,
            roll_number INTEGER DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await ensureColumn(db, 'pending_magic_confirmations', 'roll_number', 'INTEGER DEFAULT NULL');

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_pending_magic_confirmations_magic
        ON pending_magic_confirmations (magic_label)
    `);

    await ensureSlotReservationsSchema(db);
    await ensureCloverTraitAttemptsSchema(db);

    await ensureCloverSettingsSchema(db);
    await ensureCloverArchiveCardsSchema(db);
    await ensureCloverAppearanceReviewSchema(db);
    await ensureCloverCharacterStatsSchema(db);
    await ensureCloverPhLedgerSchema(db);
    await ensureCloverYullsLedgerSchema(db);
    await ensureCloverRecruitmentSchema(db);
    await ensureCloverInventorySchema(db);
    await ensureCloverRaidSchema(db);
    await ensureCloverEconomySchema(db);
    await ensureCloverQuickEvaluationsSchema(db);
    await ensureCloverSquadSchema(db);
    await ensureCloverSkillTreeSchema(db);
    await ensureCloverManaHexagonSchema(db);
    await ensureCloverSiteAuthSchema(db);
    await ensureCloverAdminServiceSchema(db);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS group_settings (
            group_id TEXT PRIMARY KEY,
            enabled INTEGER DEFAULT 0,
            reception_enabled INTEGER DEFAULT 0,
            reception_type TEXT DEFAULT NULL,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await ensureColumn(db, 'group_settings', 'reception_enabled', 'INTEGER DEFAULT 0');
    await ensureColumn(db, 'group_settings', 'reception_type', 'TEXT DEFAULT NULL');

    await db.exec(`
        CREATE TABLE IF NOT EXISTS group_member_welcomes (
            group_id TEXT NOT NULL,
            player_id TEXT NOT NULL,
            welcome_sent_at TEXT DEFAULT NULL,
            last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (group_id, player_id)
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_player_rolls_player
        ON player_rolls (player_id)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_jogadores_aparencia_normalizada
        ON jogadores (personagem_aparencia_normalizada)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_jogadores_historia_status
        ON jogadores (ficha_status, historia_status)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_jogadores_jogo_status
        ON jogadores (ficha_status, personagem_aparencia_status, historia_status, jogo_status)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_group_member_welcomes_player
        ON group_member_welcomes (player_id)
    `);
    
    return db;
}

module.exports = {
    criarBanco,
    ensureCloverAppearanceReviewSchema,
    ensureCloverCharacterStatsSchema,
    ensureCloverInventorySchema,
    ensureCloverRaidSchema,
    ensureCloverEconomySchema,
    ensureCloverManaHexagonSchema,
    ensureCloverPhLedgerSchema,
    ensureCloverYullsLedgerSchema,
    ensureCloverRecruitmentSchema,
    ensureCloverQuickEvaluationsSchema,
    ensureCloverSiteAuthSchema,
    ensureCloverAdminServiceSchema,
    ensureCloverSkillTreeSchema,
    ensureCloverSettingsSchema,
    ensureCloverSquadSchema,
    ensureCloverArchiveCardsSchema,
    ensureCloverTraitAttemptsSchema,
    ensureSlotReservationsSchema,
};
