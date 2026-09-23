'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const { addCatalogItemInTransaction } = require('../helpers/clover/inventoryService');
const { addYullsInTransaction } = require('../helpers/clover/yullsService');

const DEFAULT_DB = path.resolve(__dirname, '..', 'banco.sqlite');
const DEFAULT_OUT_DIR = path.resolve(__dirname, '..', 'artifacts', 'reward-reconciliation-20260810');
const REPORT_MD = 'REWARD_RECONCILIATION_20260810.md';
const REPORT_JSON = 'REWARD_RECONCILIATION_20260810.json';
const CONFIRM = 'APLICAR-RECOMPENSAS-HISTORICAS-20260810';
const ACTOR = 'codex:historical-reward-reconciliation-20260810';

const STATUS = Object.freeze({
  DELIVERED: 'ALREADY_DELIVERED',
  MISSING: 'MISSING',
  PARTIAL: 'PARTIAL',
  AMBIGUOUS: 'AMBIGUOUS',
  BLOCKED: 'BLOCKED_IDENTITY',
});

const EVENTS = Object.freeze({
  ADMISSION: 'exame-admissao-2026-07-31',
  DOORS_REPAIR: 'video-feedback-2026-08-06-event-rewards-v2',
  SKARNER: 'missao-esquadrao-veu-negro-skarner-2026-08-02',
  LEGACY_20260618: 'legacy-event-rewards-2026-06-18',
  NIGHTMARE: 'pesadelo_v1',
});

const ADMISSION = Object.freeze([
  approved('Reina', null, null, ['Reina'], { blocked: 'current manifest has no safe character/squad identity' }),
  approved('Kaguya', 'Yumi', '154056970502206@lid'),
  approved('Juan', 'Minerva', '148786307420169@lid'),
  approved('Carlos', 'Caelan', '137207394385956@lid'),
  approved('Buenos', 'Fiora', '186895568998433@lid'),
  approved('Pedro', 'Majin', '273091351560194@lid'),
  approved('Mury', 'Yamato', '559294453437@s.whatsapp.net'),
  failed('Venus', 'Celeste', '558193421445@s.whatsapp.net'),
  approved('Horny', 'Choso', '169857467306095@lid'),
  failed('Autorita', 'Firefly', '16200784429134@lid'),
  approved('Fake', 'Masaki', '129403438817389@lid'),
  approved('Kaique', 'Feitan', '223913892126877@lid'),
  approved('Murilo', 'Daisuke', '222367670341744@lid'),
  approved('Dante', 'Kaito', '27019739943060@lid'),
  approved('Thiago', 'Son Gohan', '231426393948202@lid'),
  approved('Calorzinho', 'Kal', '99166634143817@lid'),
  approved('Hades', 'Poseidon', '5511939393047@s.whatsapp.net'),
  approved('Antony', 'Prinx', '178043607900320@lid'),
  approved('Rick', 'Hades', '277683191676982@lid'),
  approved('Kamogawa', 'Shinra', '108521593016567@lid', ['Shinra', 'Fuyumura'], {
    note: 'historic row maps Kamogawa/Shinra to the current Fuyumura identity',
  }),
  approved('Caua', 'Finn', '279366282035427@lid'),
  approved('Erick', 'Scarlett', '144542946832521@lid', ['Scarlett'], {
    note: 'current identity may be archived; historical reward is still auditable',
  }),
  approved('Miguel', null, '114267655278622@lid', ['Miguel'], {
    ambiguous: 'old grant associates Miguel to Mondred, but current canonical manifest says character was not safely informed',
  }),
  approved('Iori Mankoshoku', 'Iori Mankoshoku', '268804839972941@lid'),
  approved('Leonhardt Feramena', 'Leonhardt Feramena', '1649384923198@lid'),
  failed('Eren', 'Hyakuya', '191568510242891@lid'),
  failed('Juan - Kitou', 'Kael Vorn', '53288347144442@lid'),
  failed('Rhyan', 'Renji', '252578604556502@lid'),
  failed('Joao', 'Sieg', '51849415684125@lid'),
  failed('Claucio', 'Amnos', '230828856610911@lid'),
]);

const DOORS = Object.freeze([
  door('Antony', 'Prinx Fingarland', '178043607900320@lid', [['ph_doors', 8]]),
  door('Roque', 'Roque Ragus', '27788606230616@lid', [['ph_doors', 8]]),
  door('Horny', 'Choso', '169857467306095@lid', [['ph_doors', 8]]),
  door('Jay', 'Sofia Yukimura', '100369208188981@lid', [['box_simple', 1], ['box_rare', 1]]),
  door('J.P Fernando', 'Leonhardt Feramena', '1649384923198@lid', [['box_rare', 1], ['ph_doors', 6]]),
  door('Waka', 'Fuyumura', '108521593016567@lid', [['box_rare', 1], ['ph_doors', 8]]),
  door('Jasmin', 'Iori Mankoshoku', '268804839972941@lid', [['box_rare', 1], ['box_simple', 1], ['ph_doors', 4]]),
  door('Hugo', 'Ragnar', '208752640815110@lid', [['box_rare', 1], ['ph_doors', 2]]),
  door('Calor', 'Kal Shinzuko', '99166634143817@lid', [['box_simple', 1], ['ph_doors', 4]]),
  door('Van', 'Oriane Zafira Kira', '13828820300@s.whatsapp.net', [['ticket_spell', 1], ['box_rare', 1], ['ph_doors', 2]]),
  door('Rup', 'Edmund Izek von Zogratis', '18236917694511@lid', [['box_rare', 1], ['box_simple', 1]]),
  door('Kat', 'Yelena Petrov', '15157493260535@lid', [['ph_mothers', 2], ['box_simple', 1]]),
  door('Felix', 'Elizabeth', '123227443617861@lid', [['box_rare', 1], ['ph_doors', 4]]),
  door('Zzz', 'Hikari Itsuki', '75858433855738@lid', [['box_rare', 1]]),
  door('Polly', 'Aylin Seraphin Veil', '225769720701008@lid', [['yulls', 5000]]),
  door('Kaique', 'Feitan', '223913892126877@lid', [['ph_doors', 14]]),
  door('Amanda', 'Norihime', '43452586819672@lid', [['box_rare', 1]]),
  door('Caique', 'Aurel Virel', '264175200763966@lid', [['ph_doors', 10]]),
  door('Basker', 'Besker D. Kaiser', '170609036251189@lid', [['custom_entitlement', 1]]),
  door('Lua', 'Junko', '76738801471621@lid', [['box_rare', 3], ['ph_doors', 10]]),
  door('Shay', 'Noel Cedric Floga', '147421145395386@lid', [['ph_doors', 12]]),
]);

const SKARNER = Object.freeze([
  skarner('Besker D. Kaiser', '170609036251189@lid', 10, 40, 2, true),
  skarner('Noctos Sun', '179555570585796@lid', 9, 36, 2, true),
  skarner('Asuka Shiori', '178623646531644@lid', 3, 12, 0, false),
  skarner('Yamihiko', '208925009948685@lid', 10, 40, 2, true),
  skarner('Gwen', '147833361588309@lid', 9, 36, 2, true),
  skarner('Artorius D. Malth', '149701705904226@lid', 10, 40, 2, true),
  skarner('Ninguem', '59537340022832@lid', 10, 40, 2, true),
]);

function approved(label, character, playerId, aliases = [], options = {}) {
  return { event: EVENTS.ADMISSION, label, character, playerId, aliases, result: 'approved', options };
}

function failed(label, character, playerId, aliases = [], options = {}) {
  return { event: EVENTS.ADMISSION, label, character, playerId, aliases, result: 'failed', options };
}

function door(label, character, playerId, rewards) {
  return { event: 'doors', label, character, playerId, rewards };
}

function skarner(character, playerId, scenes, ph, stars, item) {
  return { event: EVENTS.SKARNER, label: character, character, playerId, scenes, ph, stars, item };
}

function parseArgs(argv) {
  const args = {
    db: DEFAULT_DB,
    outDir: DEFAULT_OUT_DIR,
    apply: false,
    confirm: null,
    noReport: false,
    selfTest: false,
    expectedPlanHash: null,
  };
  for (const arg of argv) {
    if (arg === '--apply') args.apply = true;
    else if (arg === '--preview') args.apply = false;
    else if (arg === '--no-report') args.noReport = true;
    else if (arg === '--self-test') args.selfTest = true;
    else if (arg.startsWith('--db=')) args.db = path.resolve(arg.slice('--db='.length));
    else if (arg.startsWith('--out-dir=')) args.outDir = path.resolve(arg.slice('--out-dir='.length));
    else if (arg.startsWith('--confirm=')) args.confirm = arg.slice('--confirm='.length);
    else if (arg.startsWith('--expected-plan-hash=')) args.expectedPlanHash = arg.slice('--expected-plan-hash='.length);
  }
  if (args.apply && args.confirm !== CONFIRM) {
    throw new Error(`Apply blocked. Use --apply --confirm=${CONFIRM}`);
  }
  return args;
}

async function openDb(filename, write = false, create = false) {
  const db = await open({
    filename,
    driver: sqlite3.Database,
    mode: write
      ? (sqlite3.OPEN_READWRITE | (create ? sqlite3.OPEN_CREATE : 0))
      : sqlite3.OPEN_READONLY,
  });
  await db.exec('PRAGMA busy_timeout=30000; PRAGMA foreign_keys=ON;');
  if (!write) await db.exec('PRAGMA query_only=ON;');
  return db;
}

function norm(value) {
  const text = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase();
  if (!text || text === '-' || text === 'cacador') return '';
  return text;
}

function maskId(id) {
  if (!id) return null;
  return `sha256:${crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 12)}`;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function hashPlan(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

async function tableExists(db, table) {
  const row = await db.get("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=?", [table]);
  return Boolean(row?.found);
}

async function loadContext(db) {
  const tables = {};
  const names = [
    'jogadores',
    'clover_player_aliases',
    'clover_ph_ledger',
    'clover_yulls_ledger',
    'clover_inventory_items',
    'clover_inventory_item_history',
    'clover_box_openings',
    'clover_consumable_uses',
    'clover_admission_exam_reward_grants',
    'clover_admission_exam_ph_corrections',
    'clover_video_repair_batches',
    'clover_video_repair_units',
    'clover_squad_mission_reward_components',
    'clover_squad_star_ledger',
    'clover_squad_star_transactions',
    'clover_legacy_event_reward_batches',
    'clover_legacy_event_reward_units',
    'clover_item_templates',
  ];
  for (const name of names) {
    tables[name] = await tableExists(db, name) ? await db.all(`SELECT * FROM ${name}`) : [];
  }
  const quick = await db.get('PRAGMA quick_check');
  const fk = await db.all('PRAGMA foreign_key_check');
  return { tables, quickCheck: Object.values(quick || {})[0] || null, foreignKeyViolations: fk.length };
}

function canonicalId(row) {
  return row?.merged_into || row?.canonical_player_id || row?.id || null;
}

function equivalentIds(ctx, id) {
  if (!id) return [];
  const rows = ctx.tables.jogadores;
  const seed = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      const links = [row.id, row.canonical_player_id, row.merged_into].filter(Boolean);
      if (links.some((link) => seed.has(link))) {
        for (const link of links) {
          if (!seed.has(link)) {
            seed.add(link);
            changed = true;
          }
        }
      }
    }
  }
  return [...seed];
}

function resolveTarget(ctx, target) {
  if (target.options?.blocked) {
    return { status: STATUS.BLOCKED, ids: [], player: null, note: target.options.blocked };
  }
  if (target.options?.ambiguous) {
    const player = ctx.tables.jogadores.find((row) => row.id === target.playerId) || null;
    return {
      status: STATUS.AMBIGUOUS,
      ids: target.playerId ? equivalentIds(ctx, target.playerId) : [],
      player,
      note: target.options.ambiguous,
    };
  }
  if (target.playerId) {
    const player = ctx.tables.jogadores.find((row) => row.id === target.playerId) || null;
    if (!player) return { status: STATUS.BLOCKED, ids: [], player: null, note: 'configured player id not found' };
    return { status: STATUS.DELIVERED, ids: equivalentIds(ctx, canonicalId(player)), player, note: target.options?.note || null };
  }
  const needles = [target.character, target.label, ...(target.aliases || [])].map(norm).filter(Boolean);
  const matches = ctx.tables.jogadores.filter((row) => {
    const hay = [row.personagem_nome, row.nome, row.nome_real, row.display_name].map(norm).filter(Boolean);
    return needles.some((needle) => hay.some((value) => value === needle));
  });
  if (matches.length !== 1) {
    return { status: matches.length ? STATUS.AMBIGUOUS : STATUS.BLOCKED, ids: matches.map((m) => m.id), player: null, note: `identity matches=${matches.length}` };
  }
  return { status: STATUS.DELIVERED, ids: equivalentIds(ctx, canonicalId(matches[0])), player: matches[0], note: null };
}

function includesAny(value, needles) {
  const text = norm(value);
  return needles.some((needle) => text.includes(norm(needle)));
}

function rowsForIds(rows, ids) {
  const set = new Set(ids);
  return rows.filter((row) => set.has(row.player_id));
}

function evidence(label, source, row) {
  return {
    label,
    source,
    reference: row?.id !== undefined ? `#${row.id}` : row?.event_key || row?.repair_key || row?.unit_key || null,
    at: row?.applied_at || row?.created_at || row?.granted_at || row?.completed_at || null,
  };
}

function classifyFromEvidence(found, identity) {
  if (identity.status === STATUS.BLOCKED) return STATUS.BLOCKED;
  if (identity.status === STATUS.AMBIGUOUS) return STATUS.AMBIGUOUS;
  return found.length ? STATUS.DELIVERED : STATUS.MISSING;
}

function component(eventKey, target, identity, componentKey, expected, found, options = {}) {
  const status = options.status || classifyFromEvidence(found, identity);
  return {
    eventKey,
    person: target.label,
    character: target.character || null,
    playerIdMasked: identity.ids[0] ? maskId(identity.ids[0]) : null,
    component: componentKey,
    expected,
    evidence: found,
    source: found.map((item) => item.source).filter(Boolean).join('; ') || null,
    status,
    note: options.note || identity.note || null,
    apply: options.apply || null,
  };
}

function auditAdmission(ctx) {
  const rows = [];
  for (const target of ADMISSION) {
    const identity = resolveTarget(ctx, target);
    const ids = identity.ids;
    const grantRows = rowsForIds(ctx.tables.clover_admission_exam_reward_grants, ids)
      .filter((row) => row.event_key === EVENTS.ADMISSION);
    const correctionRows = rowsForIds(ctx.tables.clover_admission_exam_ph_corrections, ids)
      .filter((row) => row.event_key === EVENTS.ADMISSION);
    const phLedger = rowsForIds(ctx.tables.clover_ph_ledger, ids).filter((row) => (
      Number(row.amount) === 60
      && ['ganho', 'ajuste_admin'].includes(String(row.kind || ''))
      && (String(row.related_id || '').includes(EVENTS.ADMISSION)
        || includesAny(`${row.source || ''} ${row.reason || ''} ${row.metadata_json || ''}`, ['exame', 'admissao']))
    ));
    const phEvidence = [
      ...grantRows.filter((row) => Number(row.ph_amount) >= 60).map((row) => evidence('grant complete package PH', 'clover_admission_exam_reward_grants', row)),
      ...correctionRows.filter((row) => Number(row.ph_amount) >= 60).map((row) => evidence('PH correction', 'clover_admission_exam_ph_corrections', row)),
      ...phLedger.map((row) => evidence('PH ledger', 'clover_ph_ledger', row)),
    ];
    rows.push(component(EVENTS.ADMISSION, target, identity, 'ph_participation', { amount: 60, unit: 'PH' }, phEvidence));

    if (target.result === 'approved') {
      const yullsLedger = rowsForIds(ctx.tables.clover_yulls_ledger, ids).filter((row) => (
        Number(row.amount) === 2500
        && (String(row.related_id || '').includes(EVENTS.ADMISSION)
          || String(row.idempotency_key || '').includes(EVENTS.ADMISSION)
          || includesAny(`${row.source || ''} ${row.reason || ''} ${row.metadata_json || ''}`, ['exame', 'admissao']))
      ));
      const yullsEvidence = [
        ...grantRows.filter((row) => Number(row.yulls_amount) >= 2500).map((row) => evidence('grant complete package Yulls', 'clover_admission_exam_reward_grants', row)),
        ...yullsLedger.map((row) => evidence('Yulls ledger', 'clover_yulls_ledger', row)),
      ];
      rows.push(component(EVENTS.ADMISSION, target, identity, 'yulls_approval_bonus', { amount: 2500, unit: 'Yulls' }, yullsEvidence, {
        apply: target.playerId ? { type: 'yulls', amount: 2500, playerId: target.playerId } : null,
      }));

      const inventoryByGrant = grantRows.filter((row) => Number(row.box_quantity) >= 2);
      const invRows = rowsForIds(ctx.tables.clover_inventory_items, ids).filter((row) => (
        row.template_key === 'box_simple_v1'
        && Number(row.quantity || 0) >= 2
        && (String(row.related_id || '').includes(EVENTS.ADMISSION)
          || includesAny(`${row.source || ''} ${row.metadata_json || ''}`, ['exame', 'admissao']))
      ));
      const historyRows = rowsForIds(ctx.tables.clover_inventory_item_history, ids).filter((row) => (
        Number(row.quantity_delta || 0) >= 2
        && (String(row.related_id || '').includes(EVENTS.ADMISSION)
          || String(row.idempotency_key || '').includes(EVENTS.ADMISSION)
          || includesAny(`${row.source || ''} ${row.metadata_json || ''}`, ['exame', 'admissao']))
      ));
      const boxEvidence = [
        ...inventoryByGrant.map((row) => evidence('grant complete package boxes', 'clover_admission_exam_reward_grants', row)),
        ...invRows.map((row) => evidence('inventory current row', 'clover_inventory_items', row)),
        ...historyRows.map((row) => evidence('inventory history row', 'clover_inventory_item_history', row)),
      ];
      rows.push(component(EVENTS.ADMISSION, target, identity, 'box_simple_approval_bonus', { amount: 2, unit: 'box_simple_v1' }, boxEvidence, {
        apply: target.playerId ? { type: 'item', templateKey: 'box_simple_v1', amount: 2, playerId: target.playerId } : null,
      }));
    }
  }
  return rows;
}

function flattenDoorUnits() {
  const units = [];
  for (const target of DOORS) {
    target.rewards.forEach((reward, index) => {
      const [kind, amount] = reward;
      const type = ['box_simple', 'box_rare', 'ticket_spell', 'custom_entitlement'].includes(kind) ? 'item' : kind;
      const templateByKind = {
        box_simple: 'box_simple_v1',
        box_rare: 'box_rare_v1',
        ticket_spell: 'ticket_feitico',
        custom_entitlement: 'pending_custom_magic_item_event_doors_v1',
      };
      const refByKind = {
        ph_doors: 'evento_das_portas',
        ph_mothers: 'evento_das_maes',
        yulls: 'evento_das_portas',
      };
      const rewardTypeByKind = {
        ph_doors: 'ph',
        ph_mothers: 'ph',
        yulls: 'yulls',
      };
      const unitByKind = {
        ph_doors: 'PH',
        ph_mothers: 'PH',
        yulls: 'Yulls',
      };
      units.push({
        target,
        index,
        kind,
        type,
        amount,
        templateKey: templateByKind[kind] || null,
        rewardType: templateByKind[kind] || rewardTypeByKind[kind] || type,
        unit: templateByKind[kind] || unitByKind[kind] || type,
        source: refByKind[kind] || 'evento_das_portas',
      });
    });
  }
  return units;
}

function auditDoors(ctx) {
  return flattenDoorUnits().map((unit) => {
    const identity = resolveTarget(ctx, unit.target);
    const unitRows = ctx.tables.clover_video_repair_units.filter((row) => (
      row.repair_key === EVENTS.DOORS_REPAIR
      && row.player_id === unit.target.playerId
      && row.reward_type === unit.rewardType
      && Number(row.amount) === unit.amount
    ));
    const batch = ctx.tables.clover_video_repair_batches.find((row) => row.repair_key === EVENTS.DOORS_REPAIR && row.status === 'applied');
    const found = unitRows.map((row) => evidence('video repair unit', 'clover_video_repair_units', row));
    if (batch && found.length) found.push(evidence('applied video repair batch', 'clover_video_repair_batches', batch));
    return component('evento-das-portas-2026-video', unit.target, identity, unit.kind, {
      amount: unit.amount,
      unit: unit.unit,
      source: unit.source,
    }, found);
  });
}

function auditSkarner(ctx) {
  const rows = [];
  for (const target of SKARNER) {
    const identity = resolveTarget(ctx, target);
    for (const [key, amount, unit, applicable] of [
      ['ph_mission', target.ph, 'PH', true],
      ['squad_stars', target.stars, 'squad_star', target.stars > 0],
      ['garras_escorpiao', 1, 'garras_escorpiao_skarner_v1', target.item],
    ]) {
      if (!applicable) continue;
      const compName = key === 'ph_mission' ? 'ph' : key === 'squad_stars' ? 'stars' : 'item';
      const componentRows = ctx.tables.clover_squad_mission_reward_components.filter((row) => (
        row.event_key === EVENTS.SKARNER
        && row.player_id === target.playerId
        && row.component === compName
        && Number(row.amount) === amount
      ));
      const found = componentRows.map((row) => evidence('mission component receipt', 'clover_squad_mission_reward_components', row));
      rows.push(component(EVENTS.SKARNER, target, identity, key, { amount, unit }, found));
    }
  }
  return rows;
}

function auditOtherRewards(ctx) {
  const rows = [];
  const batch = ctx.tables.clover_legacy_event_reward_batches.find((row) => row.status === 'applied');
  const units = ctx.tables.clover_legacy_event_reward_units;
  if (batch && units.length >= 8) {
    rows.push({
      eventKey: EVENTS.LEGACY_20260618,
      person: 'legacy manifest batch',
      character: null,
      playerIdMasked: null,
      component: '8 legacy inventory reward resolutions',
      expected: { amount: 8, unit: 'inventory_resolution' },
      evidence: [
        evidence('applied legacy batch', 'clover_legacy_event_reward_batches', batch),
        { label: `${units.length} unit receipts`, source: 'clover_legacy_event_reward_units', reference: null, at: null },
      ],
      source: 'clover_legacy_event_reward_batches; clover_legacy_event_reward_units',
      status: STATUS.DELIVERED,
      note: 'Discovered from data/inventory/legacy-event-reward-resolutions-v1.json; no additional objective missing component found.',
      apply: null,
    });
  }
  const nightmareEvidence = [];
  const nightmarePh = ctx.tables.clover_ph_ledger.filter((row) => (
    row.source === 'evento_pesadelo'
    || String(row.related_id || '').startsWith('pesadelo_v1:')
    || String(row.metadata_json || '').includes('pesadelo_v1')
  ));
  const nightmareYulls = ctx.tables.clover_yulls_ledger.filter((row) => (
    String(row.idempotency_key || '').startsWith('pesadelo_v1:')
    || String(row.related_id || '').includes('pesadelo_v1')
    || String(row.metadata_json || '').includes('pesadelo_v1')
  ));
  const nightmareItems = ctx.tables.clover_inventory_item_history.filter((row) => (
    String(row.idempotency_key || '').startsWith('pesadelo_v1:')
    || String(row.related_id || '').includes('pesadelo_v1')
    || String(row.metadata_json || '').includes('pesadelo_v1')
  ));
  const unique = (rows) => new Set(rows.map((row) => row.player_id).filter(Boolean)).size;
  const itemTotals = {};
  for (const row of nightmareItems) {
    const key = String(row.idempotency_key || '').split(':').pop() || 'unknown';
    itemTotals[key] ||= { rows: 0, players: new Set(), total: 0 };
    itemTotals[key].rows += 1;
    if (row.player_id) itemTotals[key].players.add(row.player_id);
    if (Number(row.quantity_delta || 0) > 0) itemTotals[key].total += Number(row.quantity_delta || 0);
  }
  const serialItemTotals = Object.fromEntries(
    Object.entries(itemTotals).map(([key, value]) => [key, {
      rows: value.rows,
      players: value.players.size,
      total: value.total,
    }])
  );
  const nightmareTotals = {
    phRows: nightmarePh.length,
    phPlayers: unique(nightmarePh),
    phTotal: nightmarePh.reduce((sum, row) => sum + Number(row.amount || 0), 0),
    yullsRows: nightmareYulls.length,
    yullsPlayers: unique(nightmareYulls),
    yullsTotal: nightmareYulls.reduce((sum, row) => sum + Number(row.amount || 0), 0),
    itemTotals: serialItemTotals,
  };
  if (nightmarePh.length) nightmareEvidence.push({ label: `PH ${nightmareTotals.phPlayers} player(s) / ${nightmareTotals.phTotal}`, source: 'clover_ph_ledger', reference: null, at: null });
  if (nightmareYulls.length) nightmareEvidence.push({ label: `Yulls ${nightmareTotals.yullsPlayers} player(s) / ${nightmareTotals.yullsTotal}`, source: 'clover_yulls_ledger', reference: null, at: null });
  if (nightmareItems.length) nightmareEvidence.push({ label: `inventory ${JSON.stringify(serialItemTotals)}`, source: 'clover_inventory_item_history', reference: null, at: null });
  rows.push({
    eventKey: EVENTS.NIGHTMARE,
    person: 'historical Nightmare manifest batch',
    character: null,
    playerIdMasked: null,
    component: '25-player reward manifest from git history',
    expected: {
      players: 25,
      yulls: 280000,
      ph: 1600,
      rareBoxes: 30,
      commonBoxes: 30,
      titles: 25,
      spellTickets: 4,
      priorityCoupons: 3,
      provisionalBlackWands: 2,
    },
    evidence: nightmareEvidence,
    source: nightmareEvidence.map((item) => item.source).join('; ') || null,
    status: STATUS.AMBIGUOUS,
    note: nightmareEvidence.length
      ? 'Found in git history commits 83659b1c..6e3156ea and live ledgers. Totals are anomalous versus manifest: expected 25 players / 1600 PH / 280000 Yulls, found 26 players / 1660 PH / 290000 Yulls. Main item totals appear present, with extra box_rare_v1/box_simple_v1 rows by alternate component key. Excluded from automatic correction.'
      : 'Found only in git history commits 83659b1c..6e3156ea; current checkout has no Nightmare scripts/tables and live ledgers did not prove delivery. Excluded from automatic correction.',
    apply: null,
  });
  return rows;
}

function summarize(components) {
  const byEvent = {};
  for (const row of components) {
    byEvent[row.eventKey] ||= { components: 0, statuses: {}, amounts: {} };
    const entry = byEvent[row.eventKey];
    entry.components += 1;
    entry.statuses[row.status] = (entry.statuses[row.status] || 0) + 1;
    if (row.expected.amount === undefined || row.expected.unit === undefined) continue;
    const key = row.expected.unit;
    entry.amounts[key] ||= {};
    entry.amounts[key][row.status] = (entry.amounts[key][row.status] || 0) + Number(row.expected.amount || 0);
  }
  return {
    expected: {
      admission: { participants: 30, approved: 23, failedFinal: 7, ph: 1800, yulls: 57500, boxSimple: 46 },
      doors: { phDoors: 100, phMothers: 2, yulls: 5000, boxRare: 13, boxSimple: 5, ticketSpell: 1, customEntitlement: 1 },
      skarner: { ph: 244, squadStars: 12, garrasEscorpiao: 6 },
      nightmare: { players: 25, yulls: 280000, ph: 1600, rareBoxes: 30, commonBoxes: 30, titles: 25, spellTickets: 4, priorityCoupons: 3, provisionalBlackWands: 2 },
    },
    byEvent,
  };
}

async function buildPlan(db) {
  const ctx = await loadContext(db);
  const components = [
    ...auditAdmission(ctx),
    ...auditDoors(ctx),
    ...auditSkarner(ctx),
    ...auditOtherRewards(ctx),
  ];
  const plan = {
    generatedAt: new Date().toISOString(),
    dbPath: DEFAULT_DB,
    writesPerformed: false,
    quickCheck: ctx.quickCheck,
    foreignKeyViolations: ctx.foreignKeyViolations,
    components,
  };
  plan.summary = summarize(components);
  plan.planHash = hashPlan({
    components: components.map((row) => ({
      eventKey: row.eventKey,
      person: row.person,
      component: row.component,
      expected: row.expected,
      status: row.status,
      apply: row.apply,
    })),
    quickCheck: plan.quickCheck,
    foreignKeyViolations: plan.foreignKeyViolations,
  });
  return plan;
}

function tableCell(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return String(text || '').replace(/\|/g, '/').replace(/\r?\n/g, ' ');
}

function renderMarkdown(plan) {
  const lines = [];
  lines.push('# Reward reconciliation 2026-08-10');
  lines.push('');
  lines.push(`Generated at: ${plan.generatedAt}`);
  lines.push(`Plan hash: ${plan.planHash}`);
  lines.push(`SQLite quick_check: ${plan.quickCheck}`);
  lines.push(`Foreign key violations: ${plan.foreignKeyViolations}`);
  lines.push('');
  lines.push('No phone numbers or raw JIDs are printed in this report.');
  lines.push('');
  lines.push('## Numeric summary');
  lines.push('');
  for (const [eventKey, summary] of Object.entries(plan.summary.byEvent)) {
    lines.push(`### ${eventKey}`);
    lines.push('');
    lines.push(`Components: ${summary.components}`);
    lines.push(`Statuses: ${JSON.stringify(summary.statuses)}`);
    lines.push(`Amounts by unit/status: ${JSON.stringify(summary.amounts)}`);
    lines.push('');
  }
  lines.push('## Required expected totals');
  lines.push('');
  lines.push('Admission: 30 participants, 23 approved, 7 failed final, 1800 PH, 57500 Yulls, 46 simple boxes.');
  lines.push('Doors: 100 PH Doors, 2 PH Mothers separated, 5000 Yulls, 13 rare boxes, 5 simple boxes, 1 spell ticket, 1 custom magic item entitlement.');
  lines.push('Skarner: 244 PH, 12 squad Stars, 6 Garras do Escorpiao.');
  lines.push('Nightmare history-only finding: 25 players, 280000 Yulls, 1600 PH, 30 rare boxes, 30 common boxes, 25 titles, 4 spell tickets, 3 priority coupons, 2 provisional black wands.');
  lines.push('');
  lines.push('## Component table');
  lines.push('');
  lines.push('| Event | Person | Character | Component | Expected | Evidence | Source | Status | Note |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const row of plan.components) {
    const ev = row.evidence.map((item) => [item.label, item.source, item.reference, item.at].filter(Boolean).join(' ')).join('; ');
    lines.push(`| ${tableCell(row.eventKey)} | ${tableCell(row.person)} | ${tableCell(row.character || '-')} | ${tableCell(row.component)} | ${tableCell(row.expected)} | ${tableCell(ev || '-')} | ${tableCell(row.source || '-')} | ${row.status} | ${tableCell(row.note || '-')} |`);
  }
  lines.push('');
  lines.push('## Apply candidates');
  lines.push('');
  const candidates = plan.components.filter((row) => row.status === STATUS.MISSING && row.apply);
  if (!candidates.length) {
    lines.push('No strong missing component is currently eligible for automatic apply.');
  } else {
    for (const row of candidates) {
      lines.push(`- ${row.eventKey} / ${row.person} / ${row.component}: ${JSON.stringify(row.expected)}`);
    }
  }
  lines.push('');
  lines.push('Preview command:');
  lines.push('');
  lines.push('```powershell');
  lines.push('node scripts/reconcileHistoricalRewards20260810.cjs --preview');
  lines.push('```');
  lines.push('');
  lines.push('Future apply command, not executed by this audit:');
  lines.push('');
  lines.push('```powershell');
  lines.push(`node scripts/reconcileHistoricalRewards20260810.cjs --apply --confirm=${CONFIRM} --expected-plan-hash=${plan.planHash}`);
  lines.push('```');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function publicPlan(plan) {
  return {
    ...plan,
    components: plan.components.map((row) => ({
      ...row,
      apply: row.apply ? {
        ...row.apply,
        playerId: undefined,
        playerIdMasked: maskId(row.apply.playerId),
      } : null,
    })),
  };
}

function writeReports(plan, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const mdPath = path.join(outDir, REPORT_MD);
  const jsonPath = path.join(outDir, REPORT_JSON);
  const reportPlan = publicPlan(plan);
  fs.writeFileSync(mdPath, renderMarkdown(reportPlan), 'utf8');
  fs.writeFileSync(jsonPath, `${JSON.stringify(reportPlan, null, 2)}\n`, 'utf8');
  return { mdPath, jsonPath };
}

function timestamp() {
  const d = new Date();
  const pad = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function createBackup(db, sourcePath) {
  const dir = path.resolve(path.dirname(sourcePath), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const backupPath = path.join(dir, `banco.before-historical-rewards-20260810-${timestamp()}.sqlite`);
  await db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  return backupPath;
}

async function ensureReceiptSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS clover_historical_reward_reconciliation_receipts (
      event_key TEXT NOT NULL,
      player_id TEXT NOT NULL,
      component TEXT NOT NULL,
      amount INTEGER NOT NULL,
      reference_id TEXT DEFAULT NULL,
      plan_hash TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      applied_by TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (event_key, player_id, component)
    );
  `);
}

async function receiptExists(db, row) {
  if (!await tableExists(db, 'clover_historical_reward_reconciliation_receipts')) return null;
  return db.get(
    `SELECT * FROM clover_historical_reward_reconciliation_receipts
     WHERE event_key=? AND player_id=? AND component=?`,
    [row.eventKey, row.apply.playerId, row.component]
  );
}

async function applyPlan(dbPath, expectedPlanHash) {
  const preDb = await openDb(dbPath, false);
  const prePlan = await buildPlan(preDb);
  await preDb.close();
  if (expectedPlanHash && expectedPlanHash !== prePlan.planHash) {
    throw new Error(`Drift detected before apply: expected ${expectedPlanHash}, got ${prePlan.planHash}`);
  }
  const candidates = prePlan.components.filter((row) => row.status === STATUS.MISSING && row.apply);
  if (!candidates.length) return { backupPath: null, applied: [], skipped: [], planHash: prePlan.planHash };

  const db = await openDb(dbPath, true);
  const backupPath = await createBackup(db, dbPath);
  await db.exec('BEGIN IMMEDIATE');
  try {
    await ensureReceiptSchema(db);
    const lockedPlan = await buildPlan(db);
    if (lockedPlan.planHash !== prePlan.planHash) {
      throw new Error(`Drift detected inside transaction: ${prePlan.planHash} -> ${lockedPlan.planHash}`);
    }
    const applied = [];
    const skipped = [];
    for (const row of candidates) {
      const existingReceipt = await receiptExists(db, row);
      if (existingReceipt) {
        skipped.push({ row, reason: 'receipt_exists' });
        continue;
      }
      let referenceId = null;
      if (row.apply.type === 'yulls') {
        const idempotencyKey = `${row.eventKey}:${row.apply.playerId}:${row.component}`;
        const mutation = await addYullsInTransaction(
          db,
          row.apply.playerId,
          row.apply.amount,
          'historical_reward_reconciliation_20260810',
          'Historical admission exam reward reconciliation',
          ACTOR,
          {
            relatedId: idempotencyKey,
            idempotencyKey,
            metadata: { event_key: row.eventKey, component: row.component, plan_hash: prePlan.planHash },
          }
        );
        referenceId = `clover_yulls_ledger:${mutation.ledgerId}`;
      } else if (row.apply.type === 'item') {
        const idempotencyKey = `${row.eventKey}:${row.apply.playerId}:${row.component}`;
        const mutation = await addCatalogItemInTransaction(
          db,
          row.apply.playerId,
          row.apply.templateKey,
          row.apply.amount,
          {
            source: 'historical_reward_reconciliation_20260810',
            relatedId: idempotencyKey,
            idempotencyKey,
            createdBy: ACTOR,
            metadata: { event_key: row.eventKey, component: row.component, plan_hash: prePlan.planHash },
          }
        );
        referenceId = `clover_inventory_items:${mutation.items.map((item) => item.id).join(',')}`;
      } else {
        throw new Error(`Unsupported apply type: ${row.apply.type}`);
      }
      await db.run(
        `INSERT INTO clover_historical_reward_reconciliation_receipts
         (event_key, player_id, component, amount, reference_id, plan_hash, metadata_json, applied_by, applied_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [
          row.eventKey,
          row.apply.playerId,
          row.component,
          Number(row.expected.amount || 0),
          referenceId,
          prePlan.planHash,
          JSON.stringify({ person: row.person, character: row.character, expected: row.expected }),
          ACTOR,
        ]
      );
      applied.push({ eventKey: row.eventKey, person: row.person, component: row.component, referenceId });
    }
    const quick = await db.get('PRAGMA quick_check');
    const fk = await db.all('PRAGMA foreign_key_check');
    if (String(Object.values(quick || {})[0]).toLowerCase() !== 'ok') throw new Error('quick_check failed after apply');
    if (fk.length) throw new Error(`foreign_key_check failed after apply: ${fk.length}`);
    await db.exec('COMMIT');
    return { backupPath, applied, skipped, planHash: prePlan.planHash };
  } catch (error) {
    await db.exec('ROLLBACK').catch(() => null);
    throw error;
  } finally {
    await db.close();
  }
}

async function initMinimalDb(file) {
  const db = await openDb(file, true, true);
  await db.exec(`
    CREATE TABLE jogadores (
      id TEXT PRIMARY KEY, nome TEXT, nome_real TEXT, display_name TEXT, personagem_nome TEXT,
      dinheiro INTEGER DEFAULT 0, canonical_player_id TEXT, merged_into TEXT, is_shadow INTEGER DEFAULT 0,
      identity_status TEXT DEFAULT 'active', lifecycle_status TEXT DEFAULT 'active'
    );
    CREATE TABLE clover_character_stats (
      player_id TEXT PRIMARY KEY, stage_key TEXT DEFAULT '1', pb_total INTEGER DEFAULT 0,
      ph_accumulated INTEGER DEFAULT 0, ph_available INTEGER DEFAULT 0
    );
    CREATE TABLE clover_ph_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT, player_id TEXT, amount INTEGER, kind TEXT, source TEXT, reason TEXT,
      related_id TEXT, created_by TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, metadata_json TEXT
    );
    CREATE TABLE clover_yulls_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT, player_id TEXT, amount INTEGER, balance_before INTEGER,
      balance_after INTEGER, kind TEXT, source TEXT, reason TEXT, related_id TEXT, idempotency_key TEXT UNIQUE,
      created_by TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, metadata_json TEXT
    );
    CREATE TABLE clover_inventory_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, player_id TEXT, item_name TEXT, description TEXT, quantity INTEGER,
      kind TEXT, source TEXT, related_id TEXT, created_by TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      metadata_json TEXT, template_key TEXT, catalog_version INTEGER DEFAULT 1, category TEXT, origin TEXT,
      status TEXT DEFAULT 'disponivel', quality TEXT DEFAULT 'comum', base_price INTEGER DEFAULT 0,
      reference_price INTEGER DEFAULT 0, durability_current INTEGER, durability_max INTEGER, bound INTEGER DEFAULT 1,
      transferable INTEGER DEFAULT 0, equipped_slot TEXT, expires_at TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      properties_json TEXT, effects_json TEXT
    );
    CREATE TABLE clover_inventory_item_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER, player_id TEXT, action TEXT,
      quantity_delta INTEGER, durability_delta INTEGER, before_json TEXT, after_json TEXT,
      source TEXT, related_id TEXT, idempotency_key TEXT, created_by TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      metadata_json TEXT
    );
    CREATE TABLE clover_item_templates (
      template_key TEXT PRIMARY KEY, catalog_version INTEGER DEFAULT 1, item_name TEXT, description TEXT,
      category TEXT, kind TEXT, origin TEXT, base_price INTEGER DEFAULT 0, default_quality TEXT DEFAULT 'comum',
      default_durability INTEGER, stackable INTEGER DEFAULT 1, transferable INTEGER DEFAULT 0,
      properties_json TEXT DEFAULT '{}', effects_json TEXT DEFAULT '{}', metadata_json TEXT DEFAULT '{}',
      active INTEGER DEFAULT 1, created_at TEXT, updated_at TEXT, is_custom INTEGER DEFAULT 0,
      requestable INTEGER DEFAULT 0, marketable INTEGER DEFAULT 0, duplicable INTEGER DEFAULT 1, created_by TEXT, updated_by TEXT, archived_at TEXT
    );
    CREATE TABLE clover_admission_exam_ph_corrections (
      event_key TEXT, player_id TEXT, player_label TEXT, character_label TEXT, exam_result TEXT,
      ph_amount INTEGER, ph_ledger_id INTEGER, snapshot_before_json TEXT, snapshot_after_json TEXT,
      applied_by TEXT, applied_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE clover_admission_exam_reward_grants (
      event_key TEXT, player_id TEXT, player_label TEXT, character_label TEXT, ph_amount INTEGER,
      yulls_amount INTEGER, box_template_key TEXT, box_quantity INTEGER, ph_ledger_id INTEGER, yulls_ledger_id INTEGER,
      inventory_item_ids_json TEXT, snapshot_before_json TEXT, snapshot_after_json TEXT, applied_by TEXT, applied_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE clover_video_repair_batches (repair_key TEXT PRIMARY KEY, status TEXT, applied_at TEXT);
    CREATE TABLE clover_video_repair_units (unit_key TEXT PRIMARY KEY, repair_key TEXT, player_id TEXT, reward_type TEXT, amount INTEGER, related_id TEXT, before_json TEXT, after_json TEXT, created_at TEXT);
    CREATE TABLE clover_squad_mission_reward_components (event_key TEXT, player_id TEXT, component TEXT, amount INTEGER, reference_id TEXT, metadata_json TEXT, applied_by TEXT, applied_at TEXT);
    CREATE TABLE clover_squad_star_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, squad_key TEXT, player_id TEXT, evaluation_id INTEGER, amount INTEGER, kind TEXT, source TEXT, reason TEXT, created_by TEXT, created_at TEXT, metadata_json TEXT);
  `);
  for (const key of ['box_simple_v1', 'box_rare_v1', 'ticket_feitico']) {
    await db.run(
      `INSERT INTO clover_item_templates(template_key,item_name,description,category,kind,origin,stackable,transferable,active,duplicable,created_by)
       VALUES(?,?,?,?,?,'Clover',1,0,1,1,'test')`,
      [key, key, key, 'caixa', key]
    );
  }
  const seedPlayers = [
    ['268804839972941@lid', 'Iori Mankoshoku', 'Iori Mankoshoku'],
    ['1649384923198@lid', 'Leonhardt Feramena', 'Leonhardt Feramena'],
    ['154056970502206@lid', 'Yumi', 'Yumi'],
    ['old-yumi@lid', 'Yumi old id', 'Yumi'],
    ['alias-current@lid', 'Alias Current', 'Alias Current'],
  ];
  for (const [id, nome, personagem] of seedPlayers) {
    const canonical = id === 'old-yumi@lid' ? '154056970502206@lid' : id;
    await db.run('INSERT INTO jogadores(id,nome,personagem_nome,dinheiro,canonical_player_id) VALUES(?,?,?,?,?)', [id, nome, personagem, 0, canonical]);
    await db.run('INSERT INTO clover_character_stats(player_id,ph_accumulated,ph_available) VALUES(?,?,?)', [id, 0, 0]);
  }
  await db.run('INSERT INTO clover_admission_exam_ph_corrections(event_key,player_id,player_label,character_label,exam_result,ph_amount,ph_ledger_id,snapshot_before_json,snapshot_after_json,applied_by) VALUES(?,?,?,?,?,?,?,?,?,?)', [EVENTS.ADMISSION, '268804839972941@lid', 'Iori', 'Iori Mankoshoku', 'aprovado', 60, 1, '{}', '{}', 'test']);
  await db.run('INSERT INTO clover_ph_ledger(player_id,amount,kind,source,reason,related_id,created_by) VALUES(?,?,?,?,?,?,?)', ['268804839972941@lid', 60, 'ganho', 'evento_exame_admissao', 'Exame', `${EVENTS.ADMISSION}:268804839972941@lid:ph`, 'test']);
  await db.run('INSERT INTO clover_admission_exam_reward_grants(event_key,player_id,player_label,character_label,ph_amount,yulls_amount,box_template_key,box_quantity,ph_ledger_id,yulls_ledger_id,inventory_item_ids_json,snapshot_before_json,snapshot_after_json,applied_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [EVENTS.ADMISSION, 'old-yumi@lid', 'Kaguya', 'Yumi', 60, 2500, 'box_simple_v1', 2, 10, 20, '[1]', '{}', '{}', 'test']);
  await db.run('INSERT INTO clover_ph_ledger(player_id,amount,kind,source,reason,related_id,created_by) VALUES(?,?,?,?,?,?,?)', ['old-yumi@lid', 60, 'ganho', 'evento_exame_admissao', 'Exame', `${EVENTS.ADMISSION}:old-yumi@lid:ph`, 'test']);
  await db.run('INSERT INTO clover_ph_ledger(player_id,amount,kind,source,reason,related_id,created_by) VALUES(?,?,?,?,?,?,?)', ['old-yumi@lid', -60, 'gasto', 'skill_shop', 'spent after reward', 'spent:test', 'test']);
  await db.run('INSERT INTO clover_yulls_ledger(player_id,amount,balance_before,balance_after,kind,source,reason,related_id,idempotency_key,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)', ['old-yumi@lid', 2500, 0, 2500, 'ganho', 'evento_exame_admissao', 'Exame', `${EVENTS.ADMISSION}:old-yumi@lid:yulls`, `${EVENTS.ADMISSION}:old-yumi@lid:yulls`, 'test']);
  await db.run('INSERT INTO clover_yulls_ledger(player_id,amount,balance_before,balance_after,kind,source,reason,related_id,idempotency_key,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)', ['old-yumi@lid', -2500, 2500, 0, 'gasto', 'shop', 'spent after reward', 'spent:yumi', 'spent:yumi', 'test']);
  await db.run('INSERT INTO clover_inventory_items(id,player_id,item_name,description,quantity,kind,source,related_id,created_by,template_key,status) VALUES(?,?,?,?,?,?,?,?,?,?,?)', [1, 'old-yumi@lid', 'Caixa Simples', 'box', 0, 'caixa', 'evento_exame_admissao', `${EVENTS.ADMISSION}:old-yumi@lid:box`, 'test', 'box_simple_v1', 'consumido']);
  await db.run('INSERT INTO clover_inventory_item_history(item_id,player_id,action,quantity_delta,source,related_id,idempotency_key,created_by) VALUES(?,?,?,?,?,?,?,?)', [1, 'old-yumi@lid', 'adicionado', 2, 'evento_exame_admissao', `${EVENTS.ADMISSION}:old-yumi@lid:box`, `${EVENTS.ADMISSION}:old-yumi@lid:box`, 'test']);
  await db.run('INSERT INTO clover_inventory_item_history(item_id,player_id,action,quantity_delta,source,related_id,idempotency_key,created_by) VALUES(?,?,?,?,?,?,?,?)', [1, 'old-yumi@lid', 'consumido', -2, 'box_opening', 'box-open:yumi', 'box-open:yumi', 'test']);
  await db.run('CREATE TABLE clover_box_openings (id INTEGER PRIMARY KEY AUTOINCREMENT, player_id TEXT, inventory_item_id INTEGER, box_key TEXT, status TEXT, idempotency_key TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)');
  await db.run('INSERT INTO clover_box_openings(player_id,inventory_item_id,box_key,status,idempotency_key) VALUES(?,?,?,?,?)', ['old-yumi@lid', 1, 'simples', 'completed', 'box-open:yumi']);
  await db.close();
}

async function runSelfTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-rewards-'));
  const dbPath = path.join(dir, 'test.sqlite');
  await initMinimalDb(dbPath);

  let db = await openDb(dbPath, false);
  const before = await buildPlan(db);
  await db.close();
  assert.equal(before.quickCheck, 'ok');
  assert(before.components.some((row) => row.person === 'Iori Mankoshoku' && row.component === 'yulls_approval_bonus' && row.status === STATUS.MISSING));
  assert(before.components.some((row) => row.person === 'Iori Mankoshoku' && row.component === 'ph_participation' && row.status === STATUS.DELIVERED));
  assert(before.components.some((row) => row.person === 'Kaguya' && row.component === 'ph_participation' && row.status === STATUS.DELIVERED), 'alias/equivalent PH should count as delivered');
  assert(before.components.some((row) => row.person === 'Kaguya' && row.component === 'yulls_approval_bonus' && row.status === STATUS.DELIVERED), 'spent Yulls should still count as delivered');
  assert(before.components.some((row) => row.person === 'Kaguya' && row.component === 'box_simple_approval_bonus' && row.status === STATUS.DELIVERED), 'opened/consumed box should still count as delivered');
  assert(before.components.some((row) => row.person === 'Reina' && row.status === STATUS.BLOCKED));

  const applied = await applyPlan(dbPath, before.planHash);
  assert(applied.applied.length >= 2);

  db = await openDb(dbPath, false);
  const after = await buildPlan(db);
  const yulls = await db.get('SELECT * FROM clover_yulls_ledger WHERE player_id=? AND amount=2500', ['268804839972941@lid']);
  const boxes = await db.get('SELECT * FROM clover_inventory_item_history WHERE player_id=? AND quantity_delta=2', ['268804839972941@lid']);
  await db.close();
  assert(yulls, 'yulls ledger should exist after apply');
  assert(boxes, 'box history should exist after apply');
  assert.notEqual(after.planHash, before.planHash, 'plan hash should drift after apply');

  const retry = await applyPlan(dbPath, after.planHash);
  assert.equal(retry.applied.length, 0, 'retry must be idempotent');

  let drifted = false;
  try {
    await applyPlan(dbPath, before.planHash);
  } catch {
    drifted = true;
  }
  assert.equal(drifted, true, 'stale plan hash must block apply');

  const rollbackDb = path.join(dir, 'rollback.sqlite');
  await initMinimalDb(rollbackDb);
  db = await openDb(rollbackDb, false);
  const rollbackPlan = await buildPlan(db);
  await db.close();
  db = await openDb(rollbackDb, true);
  await db.run("DELETE FROM clover_item_templates WHERE template_key='box_simple_v1'");
  await db.close();
  let rolledBack = false;
  try {
    await applyPlan(rollbackDb, rollbackPlan.planHash);
  } catch {
    rolledBack = true;
  }
  assert.equal(rolledBack, true, 'apply error should throw');
  db = await openDb(rollbackDb, false);
  const leaked = await db.get('SELECT * FROM clover_yulls_ledger WHERE player_id=? AND amount=2500', ['268804839972941@lid']);
  const fk = await db.all('PRAGMA foreign_key_check');
  await db.close();
  assert.equal(leaked, undefined, 'rollback should remove earlier yulls mutation');
  assert.equal(fk.length, 0, 'foreign_key_check should stay clean');

  return { ok: true, dir };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    const result = await runSelfTest();
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (args.apply) {
    const result = await applyPlan(args.db, args.expectedPlanHash);
    console.log(JSON.stringify({ ok: true, apply: result }, null, 2));
    return;
  }

  const db = await openDb(args.db, false);
  try {
    const plan = await buildPlan(db);
    const files = args.noReport ? null : writeReports(plan, args.outDir);
    console.log(JSON.stringify({
      ok: true,
      mode: 'preview',
      writesPerformed: false,
      planHash: plan.planHash,
      files,
      summary: plan.summary,
    }, null, 2));
  } finally {
    await db.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message, stack: error.stack }, null, 2));
    process.exitCode = 1;
  });
}

module.exports = {
  ADMISSION,
  DOORS,
  SKARNER,
  STATUS,
  auditAdmission,
  auditDoors,
  auditSkarner,
  buildPlan,
  hashPlan,
  parseArgs,
  runSelfTest,
};
