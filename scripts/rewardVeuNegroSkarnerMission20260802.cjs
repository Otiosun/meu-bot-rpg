'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    ensureCloverInventorySchema,
    ensureCloverSquadSchema,
} = require('../database');
const {
    addPhInTransaction,
    ensurePhState,
} = require('../helpers/clover/phService');
const {
    addCatalogItemInTransaction,
} = require('../helpers/clover/inventoryService');

const DB_PATH = path.resolve(__dirname, '..', 'banco.sqlite');
const BACKUP_DIR = path.resolve(__dirname, '..', 'backups');

const EVENT_KEY = 'missao-esquadrao-veu-negro-skarner-2026-08-02';
const EVENT_SOURCE = 'missao_esquadrao_veu_negro';
const PH_REASON = 'Missão de Esquadrão — combate ao desmatamento com Skarner';
const STAR_REASON = 'Missão de Esquadrão — participação completa nas narrações de Skarner';
const ACTOR_ID = 'local-admin:missao-veu-negro-skarner-2026-08-02';
const APPLY_CONFIRMATION = 'APLICAR-MISSAO-VEU-NEGRO-SKARNER-2026-08-02';

const SQUAD_NAME = 'Véu Negro';
const ITEM_TEMPLATE_KEY = 'garras_escorpiao_skarner_v1';
const ITEM_NAME = 'Garras do Escorpião';
const ITEM_DESCRIPTION = 'Após ajudar Skarner no combate contra o desmatamento, ele fez uma manopla para cada participante da missao, usando sua própria carne e carapaça pra isso.';
const ITEM_EFFECT = 'Ao gastar - 600 de mana, a manopla ativa um mecanismo que lança um ferrão de Escorpião semelhante a uma kunai ligada a uma corrente que pode se estender a um alcance de 10 metros, no máximo. A velocidade e resistência do ferrão, corrente e manopla equivale ao poder mágico do usuário aumentado em 10%. Caso o ferrão atinja ou arranhe alguém diretamente, ele injetará uma substância venenosa paralisante que causará um debuff de - 10% de velocidade e agilidade no oponente. O efeito único dura um turno, no próximo turno o ferrão retorna para a manopla. Para ativar novamente o efeito único, terá de gastar - 600 de mana.';
const ITEM_FULL_DESCRIPTION = `Descrição: ${ITEM_DESCRIPTION}\n\nEfeito Único: ${ITEM_EFFECT}`;

const TARGETS = Object.freeze([
    {
        label: 'Besker',
        playerId: '170609036251189@lid',
        acceptedNames: ['Besker D. Kaiser'],
        scenes: 10,
        ph: 40,
        stars: 2,
        item: true,
    },
    {
        label: 'Noctos',
        playerId: '179555570585796@lid',
        acceptedNames: ['Noctos Sun'],
        scenes: 9,
        ph: 36,
        stars: 2,
        item: true,
    },
    {
        label: 'Asuka Shiori',
        playerId: '178623646531644@lid',
        acceptedNames: ['Asuka Shiori'],
        scenes: 3,
        ph: 12,
        stars: 0,
        item: false,
    },
    {
        label: 'Yamihiko Zogratis',
        playerId: '208925009948685@lid',
        acceptedNames: ['Yamihiko.', 'Yamihiko', 'Yamihiko Zogratis'],
        scenes: 10,
        ph: 40,
        stars: 2,
        item: true,
    },
    {
        label: 'Gwen',
        playerId: '147833361588309@lid',
        acceptedNames: ['Gwen.', 'Gwen'],
        scenes: 9,
        ph: 36,
        stars: 2,
        item: true,
    },
    {
        label: 'Artorius',
        playerId: '149701705904226@lid',
        acceptedNames: ['Artorius D.Malth', 'Artorius D. Malth'],
        scenes: 10,
        ph: 40,
        stars: 2,
        item: true,
    },
    {
        label: 'Ninguém',
        playerId: '59537340022832@lid',
        acceptedNames: ['Ninguém'],
        scenes: 10,
        ph: 40,
        stars: 2,
        item: true,
    },
]);

function normalizeText(value) {
    return String(value ?? '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .toLowerCase();
}

function parseArguments(argv) {
    const apply = argv.includes('--apply');
    const explicitPreview = argv.includes('--preview');
    const confirmationArg = argv.find((arg) => arg.startsWith('--confirm='));
    const confirmation = confirmationArg
        ? confirmationArg.slice('--confirm='.length)
        : null;

    if (apply && explicitPreview) {
        throw new Error('Use apenas --preview ou --apply, nunca os dois juntos.');
    }

    if (apply && confirmation !== APPLY_CONFIRMATION) {
        throw new Error(
            `Aplicação bloqueada. Use --apply --confirm=${APPLY_CONFIRMATION}`
        );
    }

    return { mode: apply ? 'apply' : 'preview' };
}

async function tableExists(db, tableName) {
    const row = await db.get(
        `SELECT 1 AS found
         FROM sqlite_master
         WHERE type = 'table' AND name = ?`,
        [tableName]
    );
    return Boolean(row);
}

async function tableColumns(db, tableName) {
    if (!await tableExists(db, tableName)) return new Set();
    const rows = await db.all(`PRAGMA table_info("${String(tableName).replace(/"/g, '""')}")`);
    return new Set(rows.map((row) => row.name));
}

function timestampForFilename(date = new Date()) {
    const pad = (value) => String(value).padStart(2, '0');
    return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
        '-',
        pad(date.getHours()),
        pad(date.getMinutes()),
        pad(date.getSeconds()),
    ].join('');
}

function escapeSqlString(value) {
    return String(value).replace(/'/g, "''");
}

async function createConsistentBackup(db) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const backupPath = path.join(
        BACKUP_DIR,
        `banco.before-veu-negro-skarner-${timestampForFilename()}.sqlite`
    );
    await db.exec(`VACUUM INTO '${escapeSqlString(backupPath)}'`);
    return backupPath;
}

function validateStaticConfiguration() {
    const ids = new Set();
    let totalPh = 0;
    let totalStars = 0;
    let totalItems = 0;

    for (const target of TARGETS) {
        if (ids.has(target.playerId)) {
            throw new Error(`ID duplicado na configuração: ${target.playerId}`);
        }
        ids.add(target.playerId);

        const calculatedPh = target.scenes * 4;
        if (target.ph !== calculatedPh) {
            throw new Error(
                `${target.label}: PH configurado ${target.ph}, mas ${target.scenes} cenas exigem ${calculatedPh}.`
            );
        }
        if (!Number.isInteger(target.stars) || target.stars < 0) {
            throw new Error(`${target.label}: estrelas inválidas.`);
        }
        if (target.label === 'Asuka Shiori' && target.item) {
            throw new Error('Asuka Shiori não pode receber Garras do Escorpião.');
        }

        totalPh += target.ph;
        totalStars += target.stars;
        totalItems += target.item ? 1 : 0;
    }

    if (totalPh !== 244 || totalStars !== 12 || totalItems !== 6) {
        throw new Error(
            `Totais estáticos divergentes: PH ${totalPh}, estrelas ${totalStars}, itens ${totalItems}.`
        );
    }

    return { totalPh, totalStars, totalItems };
}

async function getSquad(db) {
    if (!await tableExists(db, 'clover_squads')) return null;
    const rows = await db.all(
        `SELECT squad_key, name, current_stars, historical_stars, black_stars
         FROM clover_squads`
    );
    const needle = normalizeText(SQUAD_NAME);
    const matches = rows.filter((row) => (
        normalizeText(row.name) === needle
        || normalizeText(row.squad_key).replace(/^squad /, '') === needle
    ));
    if (matches.length !== 1) return null;
    return {
        ...matches[0],
        current_stars: Number(matches[0].current_stars || 0),
        historical_stars: Number(matches[0].historical_stars || 0),
    };
}

async function getPlayerSnapshot(db, target) {
    const row = await db.get(
        `SELECT
             j.id,
             j.nome,
             j.personagem_nome,
             j.display_name,
             j.esquadrao,
             j.estrelas,
             j.ficha_status,
             j.jogo_status,
             j.canonical_player_id,
             j.merged_into,
             j.is_shadow,
             j.identity_status,
             j.lifecycle_status,
             s.ph_available,
             s.ph_accumulated
         FROM jogadores j
         LEFT JOIN clover_character_stats s
           ON s.player_id = j.id
         WHERE j.id = ?`,
        [target.playerId]
    );
    if (!row) return null;
    return {
        ...row,
        estrelas: Number(row.estrelas || 0),
        ph_available: row.ph_available === null || row.ph_available === undefined
            ? null
            : Number(row.ph_available),
        ph_accumulated: row.ph_accumulated === null || row.ph_accumulated === undefined
            ? null
            : Number(row.ph_accumulated),
    };
}

function validatePlayer(target, snapshot) {
    const problems = [];
    const warnings = [];

    if (!snapshot) {
        problems.push('jogador não encontrado');
        return { problems, warnings };
    }

    const actualNames = [snapshot.personagem_nome, snapshot.nome]
        .map(normalizeText)
        .filter(Boolean);
    const acceptedNames = target.acceptedNames.map(normalizeText);
    if (!acceptedNames.some((name) => actualNames.includes(name))) {
        problems.push(
            `personagem divergente: banco="${snapshot.personagem_nome || snapshot.nome || '-'}"`
        );
    }

    if (normalizeText(snapshot.esquadrao) !== normalizeText(SQUAD_NAME)) {
        problems.push(`esquadrão divergente: ${snapshot.esquadrao || 'sem esquadrão'}`);
    }
    if (snapshot.merged_into) problems.push(`registro fundido em ${snapshot.merged_into}`);
    if (Number(snapshot.is_shadow || 0) === 1) problems.push('registro marcado como sombra');
    if (snapshot.canonical_player_id && snapshot.canonical_player_id !== snapshot.id) {
        problems.push(`canonical_player_id aponta para ${snapshot.canonical_player_id}`);
    }
    if (normalizeText(snapshot.identity_status) === 'inactive') {
        problems.push('identidade inativa');
    }
    if (normalizeText(snapshot.jogo_status) !== 'liberado') {
        problems.push(`jogo_status=${snapshot.jogo_status || 'null'}`);
    }
    if (!['aprovada', 'confirmada'].includes(normalizeText(snapshot.ficha_status))) {
        problems.push(`ficha_status=${snapshot.ficha_status || 'null'}`);
    }
    if (normalizeText(snapshot.lifecycle_status) !== 'active') {
        warnings.push(`lifecycle_status=${snapshot.lifecycle_status || 'null'}`);
    }
    if (snapshot.ph_available === null || snapshot.ph_accumulated === null) {
        warnings.push('estado de PH ainda não inicializado');
    }

    return { problems, warnings };
}

async function ensureAuditSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_squad_mission_reward_components (
            event_key TEXT NOT NULL,
            player_id TEXT NOT NULL,
            component TEXT NOT NULL CHECK (component IN ('ph', 'stars', 'item')),
            amount INTEGER NOT NULL,
            reference_id TEXT DEFAULT NULL,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            applied_by TEXT NOT NULL,
            applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (event_key, player_id, component)
        );

        CREATE INDEX IF NOT EXISTS idx_squad_mission_reward_components_player
        ON clover_squad_mission_reward_components (player_id, applied_at DESC);
    `);
}

async function getAuditComponent(db, playerId, component) {
    if (!await tableExists(db, 'clover_squad_mission_reward_components')) return null;
    return db.get(
        `SELECT *
         FROM clover_squad_mission_reward_components
         WHERE event_key = ? AND player_id = ? AND component = ?`,
        [EVENT_KEY, playerId, component]
    );
}

async function getExistingPh(db, target) {
    if (!await tableExists(db, 'clover_ph_ledger')) return null;
    return db.get(
        `SELECT id, amount, kind, source, reason, related_id, created_at
         FROM clover_ph_ledger
         WHERE player_id = ?
           AND related_id = ?
         ORDER BY id ASC
         LIMIT 1`,
        [target.playerId, `${EVENT_KEY}:${target.playerId}:ph`]
    );
}

async function getExistingStars(db, squad, target) {
    if (!target.stars || !await tableExists(db, 'clover_squad_star_ledger')) return null;
    const columns = await tableColumns(db, 'clover_squad_star_ledger');
    const relatedClause = columns.has('related_id')
        ? 'OR related_id = ?'
        : '';
    const params = [
        squad.squad_key,
        target.playerId,
        target.stars,
        `%"event_key":"${EVENT_KEY}"%`,
    ];
    if (columns.has('related_id')) {
        params.push(`${EVENT_KEY}:${target.playerId}:stars`);
    }
    return db.get(
        `SELECT *
         FROM clover_squad_star_ledger
         WHERE squad_key = ?
           AND player_id = ?
           AND amount = ?
           AND kind = 'ganho'
           AND (metadata_json LIKE ? ${relatedClause})
         ORDER BY id ASC
         LIMIT 1`,
        params
    );
}

async function getExistingItems(db, target) {
    if (!await tableExists(db, 'clover_inventory_items')) return [];
    return db.all(
        `SELECT id, player_id, template_key, item_name, quantity, status, source,
                related_id, created_at
         FROM clover_inventory_items
         WHERE player_id = ?
           AND template_key = ?
           AND quantity > 0
         ORDER BY id ASC`,
        [target.playerId, ITEM_TEMPLATE_KEY]
    );
}

async function inspectTarget(db, squad, target) {
    const snapshot = await getPlayerSnapshot(db, target);
    const validation = validatePlayer(target, snapshot);

    const [phAudit, starAudit, itemAudit, phLedger, starLedger, items] = await Promise.all([
        getAuditComponent(db, target.playerId, 'ph'),
        target.stars ? getAuditComponent(db, target.playerId, 'stars') : null,
        target.item ? getAuditComponent(db, target.playerId, 'item') : null,
        getExistingPh(db, target),
        target.stars ? getExistingStars(db, squad, target) : null,
        getExistingItems(db, target),
    ]);

    if (phAudit && !phLedger) {
        validation.problems.push('auditoria de PH existe sem lançamento correspondente');
    }
    if (starAudit && !starLedger) {
        validation.problems.push('auditoria de Estrelas existe sem lançamento correspondente');
    }
    if (itemAudit && !items.length) {
        validation.problems.push('auditoria de item existe sem item correspondente');
    }
    if (!target.item && items.length) {
        validation.problems.push('Asuka possui Garras do Escorpião, mas deve ser excluída do item');
    }

    return {
        target,
        snapshot,
        problems: validation.problems,
        warnings: validation.warnings,
        ph: {
            received: Boolean(phAudit || phLedger),
            audit: phAudit,
            ledger: phLedger,
        },
        stars: {
            applicable: target.stars > 0,
            received: target.stars === 0 || Boolean(starAudit || starLedger),
            audit: starAudit,
            ledger: starLedger,
        },
        item: {
            applicable: target.item,
            received: !target.item || Boolean(itemAudit || items.length),
            audit: itemAudit,
            rows: items,
        },
    };
}

async function inspectAll(db) {
    const squad = await getSquad(db);
    if (!squad) {
        return {
            squad: null,
            rows: [],
            globalProblems: ['Véu Negro não foi localizado de forma única em clover_squads.'],
        };
    }
    const rows = [];
    for (const target of TARGETS) {
        rows.push(await inspectTarget(db, squad, target));
    }
    return { squad, rows, globalProblems: [] };
}

function summarizeInspection(inspection) {
    const blocked = inspection.globalProblems.length > 0
        || inspection.rows.some((row) => row.problems.length > 0);
    const pendingPh = inspection.rows.filter((row) => !row.ph.received);
    const pendingStars = inspection.rows.filter(
        (row) => row.stars.applicable && !row.stars.received
    );
    const pendingItems = inspection.rows.filter(
        (row) => row.item.applicable && !row.item.received
    );
    return {
        blocked,
        pendingPh,
        pendingStars,
        pendingItems,
        pendingPhTotal: pendingPh.reduce((sum, row) => sum + row.target.ph, 0),
        pendingStarsTotal: pendingStars.reduce((sum, row) => sum + row.target.stars, 0),
        pendingItemTotal: pendingItems.length,
    };
}

function printInspection(inspection, mode) {
    const summary = summarizeInspection(inspection);
    console.log('============================================================');
    console.log('MISSÃO DE ESQUADRÃO — VÉU NEGRO / SKARNER');
    console.log(`MODO: ${mode.toUpperCase()}`);
    console.log(`BANCO: ${DB_PATH}`);
    console.log(`EVENTO: ${EVENT_KEY}`);
    console.log('REGRA DE PH: 4 PH por narração concluída');
    console.log('ITEM: Garras do Escorpião para todos, exceto Asuka Shiori');
    console.log('============================================================');

    for (const problem of inspection.globalProblems) {
        console.log(`ERRO GLOBAL: ${problem}`);
    }

    if (inspection.squad) {
        console.log(
            `Esquadrão: ${inspection.squad.name} (${inspection.squad.squad_key}) | ` +
            `Estrelas ${inspection.squad.current_stars} atuais / ` +
            `${inspection.squad.historical_stars} históricas`
        );
    }

    for (const [index, row] of inspection.rows.entries()) {
        const status = row.problems.length
            ? 'BLOQUEADO'
            : row.ph.received && row.stars.received && row.item.received
                ? 'CONCLUÍDO'
                : 'PENDENTE';
        console.log(
            `\n${String(index + 1).padStart(2, '0')}. [${status}] ` +
            `${row.target.label} | ${row.snapshot?.personagem_nome || '-'} | ` +
            `${row.target.scenes} cenas`
        );
        console.log(`    ID: ${row.target.playerId}`);
        if (row.snapshot) {
            console.log(
                `    PH: ${row.snapshot.ph_available ?? '?'} disp. / ` +
                `${row.snapshot.ph_accumulated ?? '?'} acum. | ` +
                `Estrelas pessoais: ${row.snapshot.estrelas}`
            );
        }
        console.log(
            `    Recompensa: +${row.target.ph} PH | +${row.target.stars} Estrelas | ` +
            `${row.target.item ? ITEM_NAME : 'sem item'}`
        );
        console.log(`    PH: ${row.ph.received ? 'já registrado' : 'pendente'}`);
        console.log(
            `    Estrelas: ${row.stars.applicable
                ? (row.stars.received ? 'já registradas' : 'pendentes')
                : 'não aplicável'}`
        );
        console.log(
            `    Item: ${row.item.applicable
                ? (row.item.received ? 'já registrado' : 'pendente')
                : 'excluído corretamente'}`
        );
        for (const problem of row.problems) console.log(`    ERRO: ${problem}`);
        for (const warning of row.warnings) console.log(`    AVISO: ${warning}`);
    }

    console.log('\n============================================================');
    console.log(`PH pendente: +${summary.pendingPhTotal}`);
    console.log(`Estrelas pendentes: +${summary.pendingStarsTotal}`);
    console.log(`Itens pendentes: ${summary.pendingItemTotal}`);
    if (summary.blocked) {
        console.log('RESULTADO: BLOQUEADO. Nenhuma escrita deve ser realizada.');
    } else if (
        !summary.pendingPh.length
        && !summary.pendingStars.length
        && !summary.pendingItems.length
    ) {
        console.log('RESULTADO: NENHUMA RECOMPENSA PENDENTE.');
    } else {
        console.log('RESULTADO: PRÉ-VALIDAÇÃO APROVADA.');
    }
    console.log('============================================================');
    return summary;
}

async function ensureItemTemplate(db) {
    await ensureCloverInventorySchema(db);
    const existing = await db.get(
        'SELECT * FROM clover_item_templates WHERE template_key = ?',
        [ITEM_TEMPLATE_KEY]
    );

    const properties = {
        item_type: 'manopla',
        mission_item: true,
        mission_key: EVENT_KEY,
        creator: 'Skarner',
        material: 'carne e carapaça de Skarner',
    };
    const effects = {
        active_ability: {
            name: 'Ferrão de Escorpião',
            mana_cost: 600,
            maximum_range_meters: 10,
            projectile_form: 'ferrão semelhante a uma kunai ligada a uma corrente',
            projectile_speed_and_resistance: 'poder mágico do usuário aumentado em 10%',
            direct_hit_effect: 'veneno paralisante',
            speed_debuff_percent: 10,
            agility_debuff_percent: 10,
            duration_turns: 1,
            return_timing: 'no turno seguinte',
            reactivation_cost_mana: 600,
            source_text: ITEM_EFFECT,
        },
    };
    const metadata = {
        event_key: EVENT_KEY,
        squad: SQUAD_NAME,
        source: EVENT_SOURCE,
        canonical_description: ITEM_DESCRIPTION,
        canonical_effect: ITEM_EFFECT,
    };

    if (existing) {
        const sameName = String(existing.item_name || '') === ITEM_NAME;
        const sameDescription = String(existing.description || '') === ITEM_FULL_DESCRIPTION;
        if (!sameName || !sameDescription) {
            throw new Error(
                `Template ${ITEM_TEMPLATE_KEY} já existe com conteúdo divergente.`
            );
        }
        return existing;
    }

    await db.run(
        `INSERT INTO clover_item_templates (
            template_key, catalog_version, item_name, description, category, kind,
            origin, base_price, default_quality, default_durability, stackable,
            transferable, properties_json, effects_json, metadata_json, active,
            is_custom, requestable, marketable, duplicable, created_by,
            created_at, updated_at
         ) VALUES (?, 1, ?, ?, 'equipamento', 'manopla', ?, 0, 'comum', NULL,
                   0, 0, ?, ?, ?, 1, 1, 0, 0, 1, ?, CURRENT_TIMESTAMP,
                   CURRENT_TIMESTAMP)`,
        [
            ITEM_TEMPLATE_KEY,
            ITEM_NAME,
            ITEM_FULL_DESCRIPTION,
            PH_REASON,
            JSON.stringify(properties),
            JSON.stringify(effects),
            JSON.stringify(metadata),
            ACTOR_ID,
        ]
    );

    return db.get(
        'SELECT * FROM clover_item_templates WHERE template_key = ?',
        [ITEM_TEMPLATE_KEY]
    );
}

async function insertAuditComponent(db, target, component, amount, referenceId, metadata) {
    await db.run(
        `INSERT INTO clover_squad_mission_reward_components (
            event_key, player_id, component, amount, reference_id,
            metadata_json, applied_by, applied_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [
            EVENT_KEY,
            target.playerId,
            component,
            amount,
            referenceId === null || referenceId === undefined ? null : String(referenceId),
            JSON.stringify(metadata || {}),
            ACTOR_ID,
        ]
    );
}

async function insertStarLedger(db, squad, target) {
    const columns = await tableColumns(db, 'clover_squad_star_ledger');
    const metadata = {
        event_key: EVENT_KEY,
        event_type: 'squad_mission',
        squad_name: SQUAD_NAME,
        player_label: target.label,
        scenes_completed: target.scenes,
        reward_basis: 'mission_narrations',
    };
    const relatedId = `${EVENT_KEY}:${target.playerId}:stars`;

    if (columns.has('related_id')) {
        const result = await db.run(
            `INSERT INTO clover_squad_star_ledger (
                squad_key, player_id, evaluation_id, amount, kind, source,
                reason, related_id, created_by, created_at, metadata_json
             ) VALUES (?, ?, NULL, ?, 'ganho', ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
            [
                squad.squad_key,
                target.playerId,
                target.stars,
                EVENT_SOURCE,
                STAR_REASON,
                relatedId,
                ACTOR_ID,
                JSON.stringify(metadata),
            ]
        );
        return result.lastID;
    }

    const result = await db.run(
        `INSERT INTO clover_squad_star_ledger (
            squad_key, player_id, evaluation_id, amount, kind, source,
            reason, created_by, created_at, metadata_json
         ) VALUES (?, ?, NULL, ?, 'ganho', ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
        [
            squad.squad_key,
            target.playerId,
            target.stars,
            EVENT_SOURCE,
            STAR_REASON,
            ACTOR_ID,
            JSON.stringify(metadata),
        ]
    );
    return result.lastID;
}

async function applyRewards(db) {
    const preflight = await inspectAll(db);
    const preflightSummary = printInspection(preflight, 'apply-preflight');
    if (preflightSummary.blocked) {
        throw new Error('Aplicação recusada: a pré-validação encontrou bloqueios.');
    }

    const hasPending = preflightSummary.pendingPh.length
        || preflightSummary.pendingStars.length
        || preflightSummary.pendingItems.length;
    if (!hasPending) {
        return {
            backupPath: null,
            phResults: [],
            starResults: [],
            itemResults: [],
        };
    }

    const backupPath = await createConsistentBackup(db);
    console.log(`\nBACKUP CRIADO: ${backupPath}`);

    await db.exec('BEGIN IMMEDIATE');
    try {
        await ensureCloverSquadSchema(db);
        await ensureAuditSchema(db);

        const locked = await inspectAll(db);
        const lockedSummary = summarizeInspection(locked);
        if (lockedSummary.blocked) {
            throw new Error('Os dados mudaram durante a operação; aplicação bloqueada.');
        }

        if (lockedSummary.pendingItems.length) {
            await ensureItemTemplate(db);
        }

        const phResults = [];
        const starResults = [];
        const itemResults = [];

        for (const row of locked.rows) {
            const { target } = row;

            if (!row.ph.received) {
                await ensurePhState(db, target.playerId);
                const before = await getPlayerSnapshot(db, target);
                const mutation = await addPhInTransaction(
                    db,
                    target.playerId,
                    target.ph,
                    EVENT_SOURCE,
                    PH_REASON,
                    ACTOR_ID,
                    {
                        event_key: EVENT_KEY,
                        event_type: 'squad_mission',
                        squad_name: SQUAD_NAME,
                        scenes_completed: target.scenes,
                        ph_per_scene: 4,
                        outside_weekly_limit: true,
                        bypass_weekly_limit: true,
                    },
                    `${EVENT_KEY}:${target.playerId}:ph`
                );
                const after = await getPlayerSnapshot(db, target);
                const availableDelta = after.ph_available - before.ph_available;
                const accumulatedDelta = after.ph_accumulated - before.ph_accumulated;
                if (availableDelta !== target.ph || accumulatedDelta !== target.ph) {
                    throw new Error(
                        `${target.label}: delta inesperado de PH ` +
                        `(${availableDelta} disponível; ${accumulatedDelta} acumulado).`
                    );
                }
                await insertAuditComponent(
                    db,
                    target,
                    'ph',
                    target.ph,
                    mutation.ledgerId,
                    { before, after }
                );
                phResults.push({ target, before, after, ledgerId: mutation.ledgerId });
            }

            if (target.stars > 0 && !row.stars.received) {
                const beforePlayer = await getPlayerSnapshot(db, target);
                const beforeSquad = await getSquad(db);

                const playerUpdate = await db.run(
                    `UPDATE jogadores
                     SET estrelas = COALESCE(estrelas, 0) + ?
                     WHERE id = ?`,
                    [target.stars, target.playerId]
                );
                if (Number(playerUpdate?.changes || 0) !== 1) {
                    throw new Error(`${target.label}: não foi possível atualizar estrelas pessoais.`);
                }

                const ledgerId = await insertStarLedger(db, locked.squad, target);
                await db.run(
                    `UPDATE clover_squads
                     SET current_stars = COALESCE(current_stars, 0) + ?,
                         historical_stars = COALESCE(historical_stars, 0) + ?,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE squad_key = ?`,
                    [target.stars, target.stars, locked.squad.squad_key]
                );

                const afterPlayer = await getPlayerSnapshot(db, target);
                const afterSquad = await getSquad(db);
                if (afterPlayer.estrelas - beforePlayer.estrelas !== target.stars) {
                    throw new Error(`${target.label}: delta inesperado nas estrelas pessoais.`);
                }
                if (
                    afterSquad.current_stars - beforeSquad.current_stars !== target.stars
                    || afterSquad.historical_stars - beforeSquad.historical_stars !== target.stars
                ) {
                    throw new Error(`${target.label}: delta inesperado nas estrelas do esquadrão.`);
                }

                await insertAuditComponent(
                    db,
                    target,
                    'stars',
                    target.stars,
                    ledgerId,
                    { beforePlayer, afterPlayer, beforeSquad, afterSquad }
                );
                starResults.push({
                    target,
                    ledgerId,
                    beforePlayer,
                    afterPlayer,
                    beforeSquad,
                    afterSquad,
                });
            }

            if (target.item && !row.item.received) {
                const relatedId = `${EVENT_KEY}:${target.playerId}:item`;
                const result = await addCatalogItemInTransaction(
                    db,
                    target.playerId,
                    ITEM_TEMPLATE_KEY,
                    1,
                    {
                        source: EVENT_SOURCE,
                        relatedId,
                        idempotencyKey: `inventory:${relatedId}`,
                        createdBy: ACTOR_ID,
                        bound: true,
                        forceSeparate: true,
                        itemName: ITEM_NAME,
                        description: ITEM_FULL_DESCRIPTION,
                        metadata: {
                            event_key: EVENT_KEY,
                            event_type: 'squad_mission',
                            squad_name: SQUAD_NAME,
                            player_label: target.label,
                            scenes_completed: target.scenes,
                        },
                        properties: {
                            mission_key: EVENT_KEY,
                            granted_for_scenes: target.scenes,
                        },
                    }
                );
                const itemIds = (result.items || [])
                    .map((item) => item.id)
                    .filter((id) => id !== null && id !== undefined);
                if (itemIds.length !== 1) {
                    throw new Error(`${target.label}: quantidade inesperada de itens criados.`);
                }
                await insertAuditComponent(
                    db,
                    target,
                    'item',
                    1,
                    itemIds[0],
                    { template_key: ITEM_TEMPLATE_KEY, related_id: relatedId }
                );
                itemResults.push({ target, itemId: itemIds[0] });
            }
        }

        await db.exec('COMMIT');
        return { backupPath, phResults, starResults, itemResults };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

function printApplied(result) {
    console.log('\n============================================================');
    console.log('RECOMPENSAS CONCLUÍDAS E COMMITADAS');
    console.log('============================================================');
    if (result.backupPath) console.log(`Backup: ${result.backupPath}`);

    for (const item of result.phResults) {
        console.log(
            `PH | ${item.target.label}: ` +
            `${item.before.ph_available} -> ${item.after.ph_available} disponível; ` +
            `${item.before.ph_accumulated} -> ${item.after.ph_accumulated} acumulado ` +
            `(ledger #${item.ledgerId})`
        );
    }
    for (const item of result.starResults) {
        console.log(
            `ESTRELAS | ${item.target.label}: ` +
            `${item.beforePlayer.estrelas} -> ${item.afterPlayer.estrelas} pessoais; ` +
            `Véu ${item.beforeSquad.current_stars} -> ${item.afterSquad.current_stars} atuais / ` +
            `${item.beforeSquad.historical_stars} -> ${item.afterSquad.historical_stars} históricas ` +
            `(ledger #${item.ledgerId})`
        );
    }
    for (const item of result.itemResults) {
        console.log(`ITEM | ${item.target.label}: ${ITEM_NAME} (inventário #${item.itemId})`);
    }

    console.log('\n============================================================');
    console.log(
        `TOTAL NOVO: +${result.phResults.reduce((sum, item) => sum + item.target.ph, 0)} PH | ` +
        `+${result.starResults.reduce((sum, item) => sum + item.target.stars, 0)} Estrelas | ` +
        `${result.itemResults.length} item(ns)`
    );
    console.log('============================================================');
}

async function main() {
    const staticTotals = validateStaticConfiguration();
    const { mode } = parseArguments(process.argv.slice(2));

    const db = await open({
        filename: DB_PATH,
        driver: sqlite3.Database,
    });
    db.configure?.('busyTimeout', 30000);
    await db.exec(`
        PRAGMA busy_timeout = 30000;
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
    `);

    try {
        console.log(
            `CONFIGURAÇÃO VALIDADA: +${staticTotals.totalPh} PH | ` +
            `+${staticTotals.totalStars} Estrelas | ${staticTotals.totalItems} itens`
        );

        if (mode === 'preview') {
            const inspection = await inspectAll(db);
            const summary = printInspection(inspection, 'preview');
            console.log('\nNenhuma escrita foi realizada.');
            if (summary.blocked) process.exitCode = 2;
            return;
        }

        const result = await applyRewards(db);
        printApplied(result);

        const verification = await inspectAll(db);
        const verificationSummary = printInspection(verification, 'verificação-final');
        if (
            verificationSummary.blocked
            || verificationSummary.pendingPh.length
            || verificationSummary.pendingStars.length
            || verificationSummary.pendingItems.length
        ) {
            throw new Error('A verificação final encontrou recompensa pendente ou inconsistência.');
        }
    } finally {
        await db.close();
    }
}

main().catch((error) => {
    console.error('\nFALHA:', error?.stack || error?.message || error);
    process.exitCode = 1;
});
