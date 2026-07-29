/* Auditoria sanitizada de posses, títulos, traços e grimório do Clover Multicolor.
 *
 * Segurança:
 * - abre banco.sqlite em modo somente leitura;
 * - não executa INSERT, UPDATE, DELETE ou migrações;
 * - remove IDs de WhatsApp/telefone e substitui jogadores por chaves P0001...;
 * - não exporta códigos de login, sessões, mensagens, e-mails ou telefones.
 *
 * Execute na raiz do projeto:
 *   node .\scripts\exportar-auditoria-posses-grimorio.js
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const projectRoot = process.cwd();
const sqlite3 = require(path.join(projectRoot, "node_modules", "sqlite3"));
const { open } = require(path.join(projectRoot, "node_modules", "sqlite"));

const databasePath = path.join(projectRoot, "banco.sqlite");
const outputDir = path.join(
  projectRoot,
  "artifacts",
  "auditoria-posses-grimorio"
);
const outputPath = path.join(outputDir, "dados-sanitizados.json");

const JSON_COLUMNS = new Set([
  "metadata_json",
  "properties_json",
  "effects_json",
  "before_json",
  "after_json",
  "result_json",
  "reward_json",
  "inventory_item_ids_json",
]);

const SENSITIVE_KEY =
  /(^|_)(phone|telefone|whatsapp|jid|token|session|password|secret|cookie|email|raw_phone|chat_id|group_id|message_id|participant_id|login_code|auth_code|otp)(_|$)/i;

function normalizeText(value) {
  const text = String(value ?? "").trim();
  return text && text !== "-" ? text : null;
}

function safeParseJson(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return value;

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function looksLikePrivateIdentifier(value) {
  if (typeof value !== "string") return false;
  const text = value.trim();

  if (/@(?:s\.whatsapp\.net|lid|g\.us)$/i.test(text)) return true;
  if (/^\+?\d[\d\s().-]{9,}$/.test(text)) return true;

  return false;
}

function stableExternalKey(value) {
  const digest = crypto
    .createHash("sha256")
    .update(String(value))
    .digest("hex")
    .slice(0, 10);

  return `EXT-${digest}`;
}

function createSanitizer(playerMap) {
  function sanitize(value, keyName = "") {
    if (value === null || value === undefined) return value;

    if (SENSITIVE_KEY.test(keyName)) {
      return "[removido]";
    }

    if (Array.isArray(value)) {
      return value.map((entry) => sanitize(entry));
    }

    if (typeof value === "object") {
      const clean = {};

      for (const [key, entry] of Object.entries(value)) {
        clean[key] = sanitize(entry, key);
      }

      return clean;
    }

    if (typeof value === "string") {
      if (playerMap.has(value)) {
        return playerMap.get(value).player_key;
      }

      if (looksLikePrivateIdentifier(value)) {
        return stableExternalKey(value);
      }
    }

    return value;
  }

  return sanitize;
}

async function tableExists(db, tableName) {
  const row = await db.get(
    `
      SELECT 1 AS found
      FROM sqlite_master
      WHERE type = 'table' AND name = ?
      LIMIT 1
    `,
    tableName
  );

  return Boolean(row?.found);
}

async function getColumns(db, tableName) {
  const escaped = tableName.replace(/"/g, '""');
  return db.all(`PRAGMA table_info("${escaped}")`);
}

async function countTable(db, tableName) {
  if (!(await tableExists(db, tableName))) return null;

  const escaped = tableName.replace(/"/g, '""');
  const row = await db.get(`SELECT COUNT(*) AS total FROM "${escaped}"`);
  return Number(row?.total ?? 0);
}

async function selectIfExists(db, tableName, sql) {
  if (!(await tableExists(db, tableName))) return [];
  return db.all(sql);
}

function mapPlayerReference(row, playerMap, playerField = "player_id") {
  const rawId = row[playerField];
  const player = playerMap.get(rawId) || {
    player_key: rawId ? stableExternalKey(rawId) : "P-UNKNOWN",
    character_name: "Não identificado",
  };

  const clean = { ...row };
  delete clean[playerField];

  return {
    player_key: player.player_key,
    character_name: player.character_name,
    ...clean,
  };
}

function sanitizeRows(rows, sanitize, playerMap, playerField = null) {
  return rows.map((rawRow) => {
    const row = {};

    for (const [key, rawValue] of Object.entries(rawRow)) {
      const parsed = JSON_COLUMNS.has(key)
        ? safeParseJson(rawValue)
        : rawValue;
      row[key] = sanitize(parsed, key);
    }

    return playerField
      ? mapPlayerReference(row, playerMap, playerField)
      : row;
  });
}

function distribution(rows, fields) {
  const counts = new Map();

  for (const row of rows) {
    const key = fields
      .map((field) => String(row[field] ?? "(vazio)"))
      .join(" | ");

    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return [...counts.entries()]
    .map(([key, total]) => ({ key, total }))
    .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
}

function includesPossessionKeyword(...values) {
  const text = values
    .filter((value) => value !== null && value !== undefined)
    .join(" ")
    .toLocaleLowerCase("pt-BR");

  return /(ticket|caixa|t[ií]tulo|cupom|item|po[cç][aã]o|kit|feiti[cç]o|grim[oó]rio|recompensa|rel[ií]quia)/i.test(
    text
  );
}

async function main() {
  if (!fs.existsSync(databasePath)) {
    throw new Error(`Banco não encontrado: ${databasePath}`);
  }

  fs.mkdirSync(outputDir, { recursive: true });

  const db = await open({
    filename: databasePath,
    driver: sqlite3.Database,
    mode: sqlite3.OPEN_READONLY,
  });

  try {
    const integrity = await db.get("PRAGMA integrity_check");

    const playerRows = await db.all(`
      SELECT
        id,
        personagem_nome,
        nome,
        reino,
        classe,
        familia,
        raca,
        grimorio,
        magia,
        formas,
        esquadrao,
        patente,
        ficha_status,
        jogo_status,
        lifecycle_status,
        aptidao_comum,
        marca_comum,
        aptidao_rara,
        marca_rara,
        anomalia,
        gancho_narrativo,
        historias_extras
      FROM jogadores
      ORDER BY
        LOWER(COALESCE(NULLIF(personagem_nome, '-'), NULLIF(nome, '-'), id)),
        id
    `);

    const playerMap = new Map();

    playerRows.forEach((row, index) => {
      const characterName =
        normalizeText(row.personagem_nome) ||
        normalizeText(row.nome) ||
        `Personagem ${index + 1}`;

      playerMap.set(row.id, {
        player_key: `P${String(index + 1).padStart(4, "0")}`,
        character_name: characterName,
      });
    });

    const sanitize = createSanitizer(playerMap);

    const players = playerRows.map((row) => {
      const ref = playerMap.get(row.id);

      return {
        player_key: ref.player_key,
        character_name: ref.character_name,
        reino: row.reino,
        classe: row.classe,
        familia: row.familia,
        raca: row.raca,
        grimorio: row.grimorio,
        magia: row.magia,
        formas: row.formas,
        esquadrao: row.esquadrao,
        patente: row.patente,
        ficha_status: row.ficha_status,
        jogo_status: row.jogo_status,
        lifecycle_status: row.lifecycle_status,
        aptidao_comum: row.aptidao_comum,
        marca_comum: row.marca_comum,
        aptidao_rara: row.aptidao_rara,
        marca_rara: row.marca_rara,
        anomalia: row.anomalia,
        gancho_narrativo: row.gancho_narrativo,
        historias_extras: row.historias_extras,
      };
    });

    const itemTemplatesRaw = await selectIfExists(
      db,
      "clover_item_templates",
      `
        SELECT
          template_key,
          catalog_version,
          item_name,
          description,
          category,
          kind,
          origin,
          base_price,
          default_quality,
          default_durability,
          stackable,
          transferable,
          properties_json,
          effects_json,
          active,
          is_custom,
          requestable,
          marketable,
          duplicable,
          created_at,
          updated_at,
          archived_at
        FROM clover_item_templates
        ORDER BY active DESC, category, kind, item_name
      `
    );

    const inventoryRaw = await selectIfExists(
      db,
      "clover_inventory_items",
      `
        SELECT
          id,
          player_id,
          item_name,
          description,
          quantity,
          kind,
          source,
          related_id,
          created_at,
          template_key,
          catalog_version,
          category,
          origin,
          status,
          quality,
          base_price,
          reference_price,
          durability_current,
          durability_max,
          bound,
          transferable,
          equipped_slot,
          expires_at,
          updated_at,
          properties_json,
          effects_json
        FROM clover_inventory_items
        ORDER BY player_id, status, category, item_name, id
      `
    );

    const inventoryHistoryRaw = await selectIfExists(
      db,
      "clover_inventory_item_history",
      `
        SELECT
          id,
          item_id,
          player_id,
          action,
          quantity_delta,
          durability_delta,
          before_json,
          after_json,
          source,
          related_id,
          created_at
        FROM clover_inventory_item_history
        ORDER BY id
      `
    );

    const reservationsRaw = await selectIfExists(
      db,
      "clover_inventory_reservations",
      `
        SELECT
          id,
          inventory_item_id,
          player_id,
          quantity,
          source_type,
          source_id,
          status,
          created_at,
          updated_at,
          released_at,
          expires_at
        FROM clover_inventory_reservations
        ORDER BY id
      `
    );

    const itemGrantsRaw = await selectIfExists(
      db,
      "clover_item_grants",
      `
        SELECT
          id,
          template_key,
          player_id,
          quantity,
          status,
          inventory_item_ids_json,
          created_at
        FROM clover_item_grants
        ORDER BY id
      `
    );

    const itemRedemptionsRaw = await selectIfExists(
      db,
      "clover_item_redemptions",
      `
        SELECT
          id,
          player_id,
          inventory_item_id,
          reservation_id,
          template_key,
          item_name,
          redemption_kind,
          request_note,
          resolution_note,
          status,
          requested_at,
          resolved_at
        FROM clover_item_redemptions
        ORDER BY id
      `
    );

    const consumableUsesRaw = await selectIfExists(
      db,
      "clover_consumable_uses",
      `
        SELECT
          id,
          player_id,
          inventory_item_id,
          template_key,
          quantity,
          context_type,
          context_id,
          effect_key,
          effect_category,
          result,
          used_at
        FROM clover_consumable_uses
        ORDER BY id
      `
    );

    const paItemUsesRaw = await selectIfExists(
      db,
      "clover_pa_item_uses",
      `
        SELECT
          id,
          evaluator_id,
          player_id,
          item_key,
          inventory_item_id,
          action,
          result_json,
          status,
          source,
          created_at
        FROM clover_pa_item_uses
        ORDER BY id
      `
    );

    const titlesRaw = await selectIfExists(
      db,
      "clover_player_titles",
      `
        SELECT
          id,
          player_id,
          title_key,
          title_name,
          source,
          related_id,
          active,
          unlocked_at,
          metadata_json
        FROM clover_player_titles
        ORDER BY player_id, active DESC, title_name
      `
    );

    const titleHistoryRaw = await selectIfExists(
      db,
      "clover_title_history",
      `
        SELECT
          id,
          title_id,
          player_id,
          title_key,
          title_name,
          action,
          source,
          related_id,
          before_active,
          after_active,
          reason,
          metadata_json,
          created_at
        FROM clover_title_history
        ORDER BY id
      `
    );

    const spellsRaw = await selectIfExists(
      db,
      "clover_spellbook_spells",
      `
        SELECT
          id,
          player_id,
          name,
          normalized_name,
          version,
          type,
          cost,
          reach,
          duration,
          effect,
          limits,
          adm_notes,
          status,
          created_at,
          updated_at,
          removed_at
        FROM clover_spellbook_spells
        ORDER BY player_id, status DESC, normalized_name, version
      `
    );

    const spellQueueRaw = await selectIfExists(
      db,
      "clover_spell_review_queue",
      `
        SELECT
          id,
          player_id,
          status,
          requested_at,
          called_at,
          closed_at,
          reason,
          review_state,
          held_at,
          hold_reason
        FROM clover_spell_review_queue
        ORDER BY id
      `
    );

    const traitTemplatesRaw = await selectIfExists(
      db,
      "clover_trait_templates",
      `
        SELECT
          id,
          canonical_key,
          name,
          slot_key,
          description,
          effect_text,
          restrictions_text,
          status,
          version,
          trait_kind,
          source,
          metadata_json,
          created_at,
          updated_at
        FROM clover_trait_templates
        ORDER BY status DESC, slot_key, name
      `
    );

    const playerTraitsRaw = await selectIfExists(
      db,
      "clover_player_traits",
      `
        SELECT
          pt.id,
          pt.player_id,
          pt.trait_id,
          pt.slot_key,
          pt.value_text,
          pt.active,
          pt.position,
          pt.source,
          pt.legacy_ref,
          pt.assignment_key,
          pt.assigned_at,
          pt.removed_at,
          tt.name AS template_name,
          tt.description AS template_description,
          tt.effect_text AS template_effect_text,
          tt.restrictions_text AS template_restrictions_text,
          tt.status AS template_status,
          tt.trait_kind AS template_trait_kind,
          tt.source AS template_source
        FROM clover_player_traits pt
        LEFT JOIN clover_trait_templates tt
          ON tt.id = pt.trait_id
        ORDER BY pt.player_id, pt.active DESC, pt.position, pt.id
      `
    );

    const playerContentRaw = await selectIfExists(
      db,
      "clover_player_content",
      `
        SELECT
          id,
          player_id,
          content_type,
          content_key,
          title,
          body,
          raw_source_text,
          mechanical_status,
          review_status,
          linked_content_id,
          version,
          active,
          source,
          created_at,
          updated_at,
          metadata_json
        FROM clover_player_content
        ORDER BY player_id, content_type, content_key, version
      `
    );

    const bonusesRaw = await selectIfExists(
      db,
      "clover_character_bonuses",
      `
        SELECT
          id,
          player_id,
          name,
          type,
          value,
          description,
          status,
          source,
          reason,
          expires_at,
          created_at,
          updated_at,
          metadata_json
        FROM clover_character_bonuses
        ORDER BY player_id, status, type, name
      `
    );

    const boxOpeningsRaw = await selectIfExists(
      db,
      "clover_box_openings",
      `
        SELECT
          id,
          player_id,
          inventory_item_id,
          box_key,
          catalog_version,
          roll,
          roll_basis_points,
          reward_key,
          result_json,
          status,
          created_at,
          completed_at
        FROM clover_box_openings
        ORDER BY id
      `
    );

    const prPurchasesRaw = await selectIfExists(
      db,
      "clover_pr_shop_purchases",
      `
        SELECT
          id,
          player_id,
          item_key,
          quantity,
          unit_pr_cost,
          total_pr_cost,
          week_key,
          status,
          result_json,
          created_at,
          completed_at,
          metadata_json
        FROM clover_pr_shop_purchases
        ORDER BY id
      `
    );

    const paPurchasesRaw = await selectIfExists(
      db,
      "clover_pa_shop_purchases",
      `
        SELECT
          id,
          evaluator_id,
          player_id,
          item_key,
          quantity,
          unit_pa_cost,
          pa_cost,
          reward_json,
          week_key,
          status,
          source,
          created_at,
          voided_at,
          reason,
          metadata_json
        FROM clover_pa_shop_purchases
        ORDER BY id
      `
    );

    const recruitmentDeliveriesRaw = await selectIfExists(
      db,
      "clover_recruitment_reward_deliveries",
      `
        SELECT
          id,
          referral_id,
          status,
          inventory_item_id,
          attempts,
          last_error,
          completed_at,
          created_at,
          updated_at
        FROM clover_recruitment_reward_deliveries
        ORDER BY id
      `
    );

    const itemTemplates = sanitizeRows(
      itemTemplatesRaw,
      sanitize,
      playerMap
    );
    const inventory = sanitizeRows(
      inventoryRaw,
      sanitize,
      playerMap,
      "player_id"
    );
    const inventoryHistory = sanitizeRows(
      inventoryHistoryRaw,
      sanitize,
      playerMap,
      "player_id"
    );
    const reservations = sanitizeRows(
      reservationsRaw,
      sanitize,
      playerMap,
      "player_id"
    );
    const itemGrants = sanitizeRows(
      itemGrantsRaw,
      sanitize,
      playerMap,
      "player_id"
    );
    const itemRedemptions = sanitizeRows(
      itemRedemptionsRaw,
      sanitize,
      playerMap,
      "player_id"
    );
    const consumableUses = sanitizeRows(
      consumableUsesRaw,
      sanitize,
      playerMap,
      "player_id"
    );
    const paItemUses = sanitizeRows(
      paItemUsesRaw.map((row) => ({
        ...row,
        evaluator_key: playerMap.get(row.evaluator_id)?.player_key ||
          (row.evaluator_id ? stableExternalKey(row.evaluator_id) : null),
      })).map(({ evaluator_id, ...row }) => row),
      sanitize,
      playerMap,
      "player_id"
    );
    const titles = sanitizeRows(
      titlesRaw,
      sanitize,
      playerMap,
      "player_id"
    );
    const titleHistory = sanitizeRows(
      titleHistoryRaw,
      sanitize,
      playerMap,
      "player_id"
    );
    const spells = sanitizeRows(
      spellsRaw,
      sanitize,
      playerMap,
      "player_id"
    );
    const spellQueue = sanitizeRows(
      spellQueueRaw,
      sanitize,
      playerMap,
      "player_id"
    );
    const traitTemplates = sanitizeRows(
      traitTemplatesRaw,
      sanitize,
      playerMap
    );
    const playerTraits = sanitizeRows(
      playerTraitsRaw,
      sanitize,
      playerMap,
      "player_id"
    );
    const playerContent = sanitizeRows(
      playerContentRaw,
      sanitize,
      playerMap,
      "player_id"
    );
    const bonuses = sanitizeRows(
      bonusesRaw,
      sanitize,
      playerMap,
      "player_id"
    );
    const boxOpenings = sanitizeRows(
      boxOpeningsRaw,
      sanitize,
      playerMap,
      "player_id"
    );
    const prPurchases = sanitizeRows(
      prPurchasesRaw,
      sanitize,
      playerMap,
      "player_id"
    );
    const paPurchases = sanitizeRows(
      paPurchasesRaw.map((row) => ({
        ...row,
        evaluator_key: playerMap.get(row.evaluator_id)?.player_key ||
          (row.evaluator_id ? stableExternalKey(row.evaluator_id) : null),
      })).map(({ evaluator_id, ...row }) => row),
      sanitize,
      playerMap,
      "player_id"
    );
    const recruitmentDeliveries = sanitizeRows(
      recruitmentDeliveriesRaw,
      sanitize,
      playerMap
    );

    const templateKeys = new Set(
      itemTemplates.map((row) => row.template_key).filter(Boolean)
    );
    const inventoryTemplateRefs = inventory.filter(
      (row) => row.template_key
    );
    const traitTemplateIds = new Set(
      traitTemplates.map((row) => row.id).filter(Boolean)
    );

    const relevantTableNames = [
      "clover_item_templates",
      "clover_inventory_items",
      "clover_inventory_item_history",
      "clover_inventory_reservations",
      "clover_item_grants",
      "clover_item_redemptions",
      "clover_consumable_uses",
      "clover_pa_item_uses",
      "clover_player_titles",
      "clover_title_history",
      "clover_spellbook_spells",
      "clover_spell_review_queue",
      "clover_trait_templates",
      "clover_player_traits",
      "clover_player_content",
      "clover_character_bonuses",
      "clover_box_openings",
      "clover_pr_shop_purchases",
      "clover_pa_shop_purchases",
      "clover_recruitment_reward_deliveries",
      "clover_active_item_effects",
      "clover_raid_item_events",
      "clover_raid_loadout_items",
      "clover_raid_reward_deliveries",
      "clover_raid_rewards",
    ];

    const tableCounts = {};

    for (const tableName of relevantTableNames) {
      tableCounts[tableName] = await countTable(db, tableName);
    }

    const spellColumns = new Set(
      (await getColumns(db, "clover_spellbook_spells")).map(
        (column) => column.name
      )
    );

    const issues = {
      inventory_without_template_reference: inventory
        .filter((row) => !row.template_key)
        .map((row) => ({
          id: row.id,
          player_key: row.player_key,
          character_name: row.character_name,
          item_name: row.item_name,
          category: row.category,
          kind: row.kind,
          source: row.source,
          status: row.status,
        })),
      inventory_with_unknown_template: inventoryTemplateRefs
        .filter((row) => !templateKeys.has(row.template_key))
        .map((row) => ({
          id: row.id,
          player_key: row.player_key,
          character_name: row.character_name,
          item_name: row.item_name,
          template_key: row.template_key,
          source: row.source,
          status: row.status,
        })),
      inventory_without_description: inventory
        .filter((row) => !normalizeText(row.description))
        .map((row) => ({
          id: row.id,
          player_key: row.player_key,
          character_name: row.character_name,
          item_name: row.item_name,
          template_key: row.template_key,
          category: row.category,
          kind: row.kind,
        })),
      traits_without_template: playerTraits
        .filter(
          (row) =>
            row.active &&
            (!row.trait_id || !traitTemplateIds.has(row.trait_id))
        )
        .map((row) => ({
          id: row.id,
          player_key: row.player_key,
          character_name: row.character_name,
          trait_id: row.trait_id,
          slot_key: row.slot_key,
          value_text: row.value_text,
          source: row.source,
        })),
      active_traits_without_template_description: playerTraits
        .filter(
          (row) =>
            row.active &&
            traitTemplateIds.has(row.trait_id) &&
            !normalizeText(row.template_description)
        )
        .map((row) => ({
          id: row.id,
          player_key: row.player_key,
          character_name: row.character_name,
          trait_id: row.trait_id,
          template_name: row.template_name,
          slot_key: row.slot_key,
        })),
      likely_possessions_stored_as_bonus: bonuses
        .filter((row) =>
          includesPossessionKeyword(
            row.name,
            row.type,
            row.value,
            row.description,
            row.reason
          )
        )
        .map((row) => ({
          id: row.id,
          player_key: row.player_key,
          character_name: row.character_name,
          name: row.name,
          type: row.type,
          value: row.value,
          description: row.description,
          status: row.status,
          source: row.source,
        })),
      likely_possessions_stored_as_player_content: playerContent
        .filter(
          (row) =>
            row.content_type === "narrative_item" ||
            includesPossessionKeyword(
              row.title,
              row.body,
              row.raw_source_text
            )
        )
        .map((row) => ({
          id: row.id,
          player_key: row.player_key,
          character_name: row.character_name,
          content_type: row.content_type,
          content_key: row.content_key,
          title: row.title,
          body: row.body,
          mechanical_status: row.mechanical_status,
          review_status: row.review_status,
          active: row.active,
          source: row.source,
        })),
    };

    const report = {
      generated_at: new Date().toISOString(),
      mode: "read-only + sanitized",
      source_database: "banco.sqlite",
      database_integrity: integrity,
      privacy: {
        raw_player_ids_exported: false,
        phones_exported: false,
        login_codes_exported: false,
        sessions_exported: false,
        messages_exported: false,
        emails_exported: false,
      },
      summary: {
        player_count: players.length,
        table_counts: tableCounts,
        inventory_distribution: {
          by_category_kind_status: distribution(inventory, [
            "category",
            "kind",
            "status",
          ]),
          by_source: distribution(inventory, ["source"]),
        },
        item_template_distribution: {
          by_category_kind_active: distribution(itemTemplates, [
            "category",
            "kind",
            "active",
          ]),
        },
        title_distribution: {
          by_active: distribution(titles, ["active"]),
          by_source: distribution(titles, ["source"]),
        },
        spell_distribution: {
          by_status_type: distribution(spells, ["status", "type"]),
          queue_by_status: distribution(spellQueue, [
            "status",
            "review_state",
          ]),
        },
        trait_distribution: {
          by_active_slot: distribution(playerTraits, [
            "active",
            "slot_key",
          ]),
          by_template_kind: distribution(playerTraits, [
            "template_trait_kind",
          ]),
        },
        spellbook_schema_gap: {
          existing_columns: [...spellColumns].sort(),
          missing_recommended_columns: [
            "spell_number",
            "spell_lineage_key",
            "inventory_item_id",
            "redemption_id",
            "review_request_id",
            "approved_at",
          ].filter((column) => !spellColumns.has(column)),
          has_usage_history_table: await tableExists(
            db,
            "clover_spell_usage_history"
          ),
        },
      },
      issues,
      data: {
        players,
        item_templates: itemTemplates,
        inventory_items: inventory,
        inventory_history: inventoryHistory,
        inventory_reservations: reservations,
        item_grants: itemGrants,
        item_redemptions: itemRedemptions,
        consumable_uses: consumableUses,
        pa_item_uses: paItemUses,
        player_titles: titles,
        title_history: titleHistory,
        spellbook_spells: spells,
        spell_review_queue: spellQueue,
        trait_templates: traitTemplates,
        player_traits_resolved: playerTraits,
        player_content: playerContent,
        character_bonuses: bonuses,
        box_openings: boxOpenings,
        pr_shop_purchases: prPurchases,
        pa_shop_purchases: paPurchases,
        recruitment_reward_deliveries: recruitmentDeliveries,
      },
    };

    fs.writeFileSync(
      outputPath,
      JSON.stringify(report, null, 2),
      "utf8"
    );

    console.log("");
    console.log("Auditoria sanitizada concluída.");
    console.log(`Arquivo gerado: ${outputPath}`);
    console.log("");
    console.log(`Jogadores pseudonimizados: ${players.length}`);
    console.log(`Itens em inventário: ${inventory.length}`);
    console.log(`Modelos de item: ${itemTemplates.length}`);
    console.log(`Títulos: ${titles.length}`);
    console.log(`Feitiços: ${spells.length}`);
    console.log(`Traços atribuídos: ${playerTraits.length}`);
    console.log("");
    console.log("Nenhum dado foi alterado.");
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error("");
  console.error("Falha na exportação:", error);
  console.error("");
  process.exitCode = 1;
});
