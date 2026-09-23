const { COMMAND_PREFIX } = require('../../config/bot');
const { normalizeText } = require('../textUtils');
const { loadCloverConfigs } = require('./configLoader');
const { getFamilySystemDetails } = require('./systemMessages');
const { getOfficialTraitDescription } = require('./traitDescriptions');

const EMPTY_VALUES = new Set(['', '-', 'n/a', 'na', 'nenhuma', 'nenhum', 'null', 'undefined']);

const characterBonusSchemaPromises = new WeakMap();

function nowSqlite() {
    return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

async function ensureCharacterBonusSchema(db) {
    if (!db?.exec) return;

    let schemaPromise = characterBonusSchemaPromises.get(db);
    if (!schemaPromise) {
        schemaPromise = db.exec(`
            CREATE TABLE IF NOT EXISTS clover_character_bonuses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                player_id TEXT NOT NULL,
                name TEXT NOT NULL,
                type TEXT DEFAULT 'narrativo',
                value TEXT DEFAULT NULL,
                description TEXT DEFAULT NULL,
                status TEXT NOT NULL DEFAULT 'ativo',
                source TEXT DEFAULT 'manual',
                reason TEXT DEFAULT NULL,
                expires_at TEXT DEFAULT NULL,
                created_by TEXT DEFAULT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                metadata_json TEXT DEFAULT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_clover_character_bonuses_player
            ON clover_character_bonuses (player_id, status, expires_at);
        `);
        characterBonusSchemaPromises.set(db, schemaPromise);

        schemaPromise.catch(() => {
            if (characterBonusSchemaPromises.get(db) === schemaPromise) {
                characterBonusSchemaPromises.delete(db);
            }
        });
    }

    return schemaPromise;
}

function normalizeBonusType(value) {
    return normalizeText(value || 'narrativo')
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'narrativo';
}

function isActiveBonusRow(row = {}) {
    if (normalizeBonusType(row.status) !== 'ativo') return false;
    if (!row.expires_at) return true;
    return String(row.expires_at) > nowSqlite();
}

async function getCustomCharacterBonuses(db, playerId, options = {}) {
    await ensureCharacterBonusSchema(db);
    const includeInactive = Boolean(options.includeInactive);
    const rows = await db.all(
        `SELECT *
         FROM clover_character_bonuses
         WHERE player_id = ?
         ${includeInactive ? '' : "AND status = 'ativo' AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))"}
         ORDER BY created_at ASC, id ASC`,
        [playerId]
    );
    return rows || [];
}

function formatCustomBonusLine(row = {}) {
    const parts = [];
    if (row.value) parts.push(String(row.value).trim());
    if (row.description) parts.push(String(row.description).trim());
    const detail = parts.filter(Boolean).join(' — ');
    const type = row.type ? `_${row.type}_` : '_narrativo_';
    const expires = row.expires_at ? ` Até ${row.expires_at}.` : '';
    return `*${row.name}* (${type})${detail ? `: ${detail}` : '.'}${expires}`;
}

function isAutomaticCustomBonus(row = {}) {
    const type = normalizeBonusType(row.type);
    return [
        'automatico',
        'automático',
        'auto',
        'reserva',
        'reserva_heart',
        'desconto',
        'mecanico',
        'mecânico',
    ].includes(type);
}

const RACE_MANA = {
    humano: 1000,
    bruxa: 5000,
    anao: 4000,
    elfo: 7000,
};

const CLASS_MANA = {
    miseravel_marginal: 1000,
    plebeu: 1000,
    artesao_comerciante: 1500,
    burguesia: 2000,
    nobreza: 3000,
    realeza: 4000,
};

const TREE_LABELS = {
    mana: 'Árvore de Mana',
    suporte: 'Árvore de Suporte',
    fisico: 'Árvore Física',
    criacao: 'Árvore de Criação',
    reforco: 'Árvore de Reforço',
};

const CLASS_TREE_DISCOUNTS = {
    miseravel_marginal: { fisico: 15 },
    plebeu: { fisico: 10 },
    artesao_comerciante: { fisico: 5, mana: 5 },
    burguesia: { fisico: 5, mana: 5 },
    nobreza: { mana: 10 },
    realeza: { mana: 15 },
};

const GRIMOIRE_TREE_DISCOUNTS = {
    clover_4f: { mana: 15 },
    diamond_4f: { fisico: 15 },
    spade_4f: { suporte: 15 },
};

const CLASS_EFFECTS = {
    miseravel_marginal: ['15% de desconto na arvore Fisica.'],
    plebeu: ['10% de desconto na arvore Fisica.'],
    artesao_comerciante: [
        '5% de desconto na arvore Fisica.',
        '5% de desconto na arvore de Mana.',
        'Salario semanal de 800¥.',
    ],
    burguesia: [
        '5% de desconto na arvore Fisica.',
        '5% de desconto na arvore de Mana.',
        'Salario semanal de 1.800¥.',
    ],
    nobreza: [
        '10% de desconto na arvore de Mana.',
        'Salario semanal de 3.500¥.',
    ],
    realeza: [
        '15% de desconto na arvore de Mana.',
        'Salario semanal de 10.000¥.',
    ],
};

const GRIMOIRE_RULES = {
    clover_3f: {
        mana: 1000,
        automatic: [],
        notAutomatic: ['+5% em Poder Magico.'],
    },
    clover_4f: {
        mana: 2000,
        automatic: [],
        notAutomatic: [
            '+20% em Poder Magico.',
            '15% de desconto na arvore de Mana.',
            'Bom agouro narrativo a favor do personagem.',
        ],
    },
    clover_demonic: {
        mana: 0,
        automatic: [],
        notAutomatic: ['Caminho narrativo para demonio, antimagia, corrupcao, pacto ou poder proibido.'],
    },
    heart_3f: {
        mana: 1000,
        reservePercent: 10,
        automatic: ['Reserva de mana natural de 10% da Mana total.'],
        notAutomatic: ['Afinidade narrativa com runas, cura, mana natural e suporte.'],
    },
    heart_4f: {
        mana: 2000,
        reservePercent: 20,
        automatic: ['Reserva de mana natural de 20% da Mana total.'],
        notAutomatic: ['A natureza responde ao usuario de forma sutil na narrativa.'],
    },
    heart_demonic: {
        mana: 0,
        automatic: [],
        notAutomatic: ['Caminho narrativo para luto, maldicao, distorcao natural ou vinculo quebrado.'],
    },
    diamond_3f: {
        mana: 1000,
        automatic: [],
        notAutomatic: ['+5% em Poder Magico, ou +10% usando magias solidas.'],
    },
    diamond_4f: {
        mana: 2000,
        automatic: [],
        notAutomatic: [
            '+20% em Poder Magico.',
            '15% de desconto na arvore Fisica.',
            'Campo de batalha pode favorecer o personagem narrativamente.',
        ],
    },
    diamond_broken: {
        mana: 0,
        automatic: [],
        notAutomatic: ['Grimorio anomalo: efeito depende de aprovacao narrativa.'],
    },
    diamond_demonic: {
        mana: 0,
        automatic: [],
        notAutomatic: ['Caminho narrativo para segunda magia, magia injetada, pagina artificial ou experimento magico.'],
    },
    spade_3f: {
        mana: 1000,
        automatic: [],
        notAutomatic: ['+5% em Poder Magico.'],
    },
    spade_4f: {
        mana: 2000,
        automatic: [],
        notAutomatic: [
            '+20% em Poder Magico.',
            '15% de desconto na arvore de Suporte.',
            'Mau agouro pesa a favor do personagem narrativamente.',
        ],
    },
    spade_demonic: {
        mana: 0,
        automatic: [],
        notAutomatic: ['Caminho narrativo para pactos, demonios, maldicoes, feiticos proibidos ou heranca sombria.'],
    },
};

function isFilled(value) {
    const normalized = normalizeText(value);
    return !EMPTY_VALUES.has(normalized);
}

function display(value, fallback = '-') {
    return isFilled(value) ? String(value).trim() : fallback;
}

function toLookupKey(value) {
    return normalizeText(value)
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function asNumber(value) {
    const parsed = Number(value || 0);
    return Number.isFinite(parsed) ? parsed : 0;
}

function formatNumber(value) {
    return Math.round(asNumber(value)).toLocaleString('pt-BR');
}

function cleanBonusText(value) {
    const text = String(value || '');
    let repaired = text;
    if (/[ÃÂ]/.test(text)) {
        try {
            const decoded = Buffer.from(text, 'latin1').toString('utf8');
            if (decoded && !decoded.includes('�')) repaired = decoded;
        } catch {
            repaired = text;
        }
    }

    return repaired
        .replace(/\bBonus\b/g, 'Bônus')
        .replace(/\bArtesao\b/g, 'Artesão')
        .replace(/\bMiseravel\b/g, 'Miserável')
        .replace(/\bFisica\b/g, 'Física')
        .replace(/\bSalario\b/g, 'Salário')
        .replace(/\bMagico\b/g, 'Mágico')
        .replace(/\bGrimorio\b/g, 'Grimório')
        .replace(/\bdemonio\b/g, 'demônio')
        .replace(/\bdemonios\b/g, 'demônios')
        .replace(/\bcorrupcao\b/g, 'corrupção')
        .replace(/\baprovacao\b/g, 'aprovação')
        .replace(/\bmal dicao\b/g, 'maldição')
        .replace(/\bmaldicao\b/g, 'maldição')
        .replace(/\bmaldicoes\b/g, 'maldições')
        .replace(/\bvinculo\b/g, 'vínculo')
        .replace(/\bsolidas\b/g, 'sólidas')
        .replace(/\banomalo\b/g, 'anômalo')
        .replace(/\bpagina\b/g, 'página')
        .replace(/\bheranca\b/g, 'herança')
        .replace(/\bfeiticos\b/g, 'feitiços')
        .replace(/â€¢/g, '•')
        .replace(/Â¥/g, '¥');
}

function isTreeDiscountEffect(value) {
    const normalized = normalizeText(value);
    return normalized.includes('desconto') && normalized.includes('arvore');
}

function normalizeOptionName(name) {
    return normalizeText(name).replace(/[^a-z0-9]+/g, ' ').trim();
}

function resolveOption(config, configId, key, label) {
    const map = config.maps[configId];
    if (!map) return null;

    const keyValue = String(key || '').trim();
    if (keyValue && map.has(keyValue)) return map.get(keyValue);

    const normalizedLabel = normalizeOptionName(label);
    if (!normalizedLabel) return null;

    return [...map.values()].find((item) => (
        normalizeOptionName(item.name) === normalizedLabel
        || normalizeOptionName(item.key) === normalizedLabel
    )) || null;
}

function resolveFallbackKey(config, configId, item, label) {
    if (item?.key) return item.key;
    const lookup = toLookupKey(label);
    const map = config.maps[configId];
    if (map?.has(lookup)) return lookup;

    const matched = resolveOption(config, configId, null, label);
    return matched?.key || lookup;
}

function resolveGrimoireRule(grimoireKey, grimoireLabel) {
    if (GRIMOIRE_RULES[grimoireKey]) return GRIMOIRE_RULES[grimoireKey];

    const normalized = normalizeOptionName(grimoireLabel);
    if (normalized.includes('3 folhas')) return GRIMOIRE_RULES.clover_3f;
    if (normalized.includes('4 folhas')) return GRIMOIRE_RULES.clover_4f;
    if (normalized.includes('5 folhas')) return GRIMOIRE_RULES.clover_demonic;
    if (normalized.includes('coracao duplo')) return GRIMOIRE_RULES.heart_4f;
    if (normalized.includes('coracao partido')) return GRIMOIRE_RULES.heart_demonic;
    if (normalized.includes('coracao')) return GRIMOIRE_RULES.heart_3f;
    if (normalized.includes('lapidado')) return GRIMOIRE_RULES.diamond_4f;
    if (normalized.includes('costurado') || normalized.includes('quebrado')) return GRIMOIRE_RULES.diamond_demonic;
    if (normalized.includes('diamante')) return GRIMOIRE_RULES.diamond_3f;
    if (normalized.includes('2 espadas')) return GRIMOIRE_RULES.spade_4f;
    if (normalized.includes('3 espadas')) return GRIMOIRE_RULES.spade_demonic;
    if (normalized.includes('1 espada')) return GRIMOIRE_RULES.spade_3f;

    return { mana: 0, automatic: [], notAutomatic: ['Grimorio sem bonus fixo configurado.'] };
}

function addTreeDiscount(discounts, treeId, percent, source) {
    const id = String(treeId || '').trim();
    const value = Math.max(0, Number(percent || 0));
    if (!id || !value) return;

    if (!discounts[id]) {
        discounts[id] = {
            treeId: id,
            label: TREE_LABELS[id] || `Árvore ${id}`,
            percent: 0,
            sources: [],
        };
    }

    discounts[id].percent += value;
    if (source) discounts[id].sources.push(source);
}

function buildTreeDiscounts(classKey, grimoireKey) {
    const discounts = {};

    for (const [treeId, percent] of Object.entries(CLASS_TREE_DISCOUNTS[classKey] || {})) {
        addTreeDiscount(discounts, treeId, percent, 'Classe Social');
    }

    for (const [treeId, percent] of Object.entries(GRIMOIRE_TREE_DISCOUNTS[grimoireKey] || {})) {
        addTreeDiscount(discounts, treeId, percent, 'Grimório');
    }

    return discounts;
}

function applyTreeDiscountCost(baseCost, discountPercent = 0) {
    const base = Math.max(0, Number(baseCost || 0));
    const percent = Math.max(0, Math.min(90, Number(discountPercent || 0)));
    if (!base || !percent) return base;
    return Math.max(1, Math.floor(base * (100 - percent) / 100));
}

function formatTreeDiscountLine(discount) {
    if (!discount?.percent) return null;
    const sources = discount.sources?.length ? ` (${[...new Set(discount.sources)].join(' + ')})` : '';
    return `Desconto automático em ${discount.label}: ${discount.percent}%${sources}.`;
}

async function getTreeDiscountForPlayer(db, playerId, treeId) {
    const summary = await getCharacterBonusSummary(db, playerId);
    const normalizedTreeId = String(treeId || '').trim();
    const discount = summary.ok ? summary.treeDiscounts?.[normalizedTreeId] : null;
    return discount || {
        treeId: normalizedTreeId,
        label: TREE_LABELS[normalizedTreeId] || `Árvore ${normalizedTreeId}`,
        percent: 0,
        sources: [],
    };
}

function getPrimaryTrait(player, rareField, commonField, rareKeyField, commonKeyField) {
    if (isFilled(player?.[rareField])) {
        return {
            label: display(player[rareField]),
            key: player?.[rareKeyField] || null,
            rarity: 'rara',
        };
    }

    if (isFilled(player?.[commonField])) {
        return {
            label: display(player[commonField]),
            key: player?.[commonKeyField] || null,
            rarity: 'comum',
        };
    }

    return {
        label: 'Nenhuma',
        key: null,
        rarity: null,
    };
}

function resolveTrait(config, trait, configIds) {
    if (!isFilled(trait?.label)) return { ...trait, found: false };

    for (const configId of configIds) {
        const item = resolveOption(config, configId, trait.key, trait.label);
        if (item) {
            return {
                ...trait,
                key: item.key,
                label: item.name,
                found: true,
                description: getOfficialTraitDescription(item.key),
            };
        }
    }

    return { ...trait, found: false };
}

function cleanFamilyNote(note) {
    return String(note || '')
        .replace(/^>\s*⤷\s*/u, '')
        .replace(/\*/g, '')
        .trim();
}

function normalizeNarrativeExtra(item) {
    if (!item) return null;

    if (typeof item === 'string') {
        const title = String(item).trim();
        if (!title) return null;
        return {
            type: 'narrativa',
            title,
            description: '',
        };
    }

    const title = display(item.title || item.titulo || item.nome || item.label || item.gn || item.gancho, '');
    if (!title) return null;

    return {
        type: normalizeText(item.type || item.kind || item.category || 'narrativa') || 'narrativa',
        title,
        description: display(item.description || item.descricao || item.text || item.detalhe || item.body || item.content, ''),
    };
}

function parseNarrativeExtras(rawValue) {
    if (!isFilled(rawValue)) return [];

    const text = String(rawValue).trim();
    if (!text || text === '-' || text === '[]') return [];

    try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
            return parsed.map((item) => normalizeNarrativeExtra(item)).filter(Boolean);
        }
    } catch {
        // fallback textual abaixo
    }

    return text
        .split(/\n{2,}/)
        .map((block) => block.trim())
        .filter(Boolean)
        .map((block) => normalizeNarrativeExtra(block))
        .filter(Boolean);
}

function summarizeNarrativeExtras(extras) {
    const titles = (extras || []).map((item) => item?.title).filter(Boolean);
    return titles.length ? titles.join(' • ') : 'Nenhum gancho narrativo registrado.';
}

function resolveOfficialNarrativeTrait(item) {
    const type = normalizeText(item?.type || '');
    if (!type.includes('traco') && !type.includes('traço')) return null;
    if (isFilled(item?.description)) return null;

    const titleKey = normalizeText(item?.title || '');
    if (!titleKey) return null;

    const config = loadCloverConfigs();
    const configIds = ['commonAptitudes', 'rareAptitudes', 'commonMarks', 'rareMarks', 'anomalies'];
    for (const configId of configIds) {
        const list = config.lists?.[configId] || [];
        const found = list.find((option) => normalizeText(option.name) === titleKey || normalizeText(option.key) === titleKey);
        if (found) {
            return {
                label: found.name,
                description: getOfficialTraitDescription(found.key),
            };
        }
    }

    return null;
}

function formatNarrativeExtras(extras) {
    if (!extras.length) return ['> Nenhum gancho narrativo registrado.'];

    return extras.flatMap((item) => {
        const officialTrait = resolveOfficialNarrativeTrait(item);
        const lines = [`*${officialTrait?.label || item.title}*`];
        if (item.type && item.type !== 'narrativa') {
            lines.push(`> Tipo: ${item.type}`);
        }
        if (officialTrait?.description?.summary) {
            lines.push(`> ${officialTrait.description.summary}`);
        }
        if (Array.isArray(officialTrait?.description?.lines) && officialTrait.description.lines.length) {
            lines.push(...officialTrait.description.lines.map((line) => `> ${line}`));
        } else if (item.description) {
            lines.push(`> ${item.description}`);
        }
        return ['', ...lines];
    }).filter(Boolean);
}

async function getSelectedRoll(db, player) {
    if (!player?.numero_roll_escolhido) return null;
    try {
        return await db.get(
            `SELECT *
             FROM player_rolls
             WHERE player_id = ? AND roll_number = ?
             LIMIT 1`,
            [player.id, player.numero_roll_escolhido]
        );
    } catch {
        return null;
    }
}

function buildClassLabel(classOption, player) {
    return cleanBonusText(display(classOption?.name || player?.classe));
}

function buildFamilySummary(config, player, selectedRoll) {
    const family = resolveOption(config, 'families', player?.familia_key, player?.familia)
        || resolveOption(config, 'families', selectedRoll?.family_key, selectedRoll?.family)
        || null;
    const key = family?.key || toLookupKey(player?.familia);
    const label = display(family?.name || player?.familia, 'Sem linhagem registrada');
    const details = getFamilySystemDetails(key);
    const hasFamily = key && key !== 'sem_linhagem' && isFilled(label) && normalizeText(label) !== 'sem linhagem registrada';

    return {
        key,
        label: hasFamily ? label : 'Sem linhagem registrada',
        details,
        notes: details?.notes?.map(cleanFamilyNote).filter(Boolean) || [],
    };
}

function buildTraitSummary(config, player) {
    const aptitude = resolveTrait(config, getPrimaryTrait(
        player,
        'aptidao_rara',
        'aptidao_comum',
        'aptidao_rara_key',
        'aptidao_comum_key'
    ), ['rareAptitudes', 'commonAptitudes']);

    const mark = resolveTrait(config, getPrimaryTrait(
        player,
        'marca_rara',
        'marca_comum',
        'marca_rara_key',
        'marca_comum_key'
    ), ['rareMarks', 'commonMarks']);

    const anomaly = resolveTrait(config, {
        label: display(player?.anomalia, 'Nenhuma'),
        key: player?.anomalia_key || null,
        rarity: null,
    }, ['anomalies']);

    const narrativeExtras = parseNarrativeExtras(player?.historias_extras);
    const hook = display(
        player?.gancho_narrativo || player?.gancho || player?.narrative_hook,
        summarizeNarrativeExtras(narrativeExtras)
    );

    return {
        aptitude,
        mark,
        anomaly,
        hook,
        narrativeExtras,
    };
}

async function getCharacterBonusSummary(db, playerId) {
    const player = await db.get('SELECT * FROM jogadores WHERE id = ?', [playerId]);
    if (!player) {
        return { ok: false, playerId, error: 'Nao encontrei esse personagem no banco.' };
    }

    const config = loadCloverConfigs();
    const selectedRoll = await getSelectedRoll(db, player);

    const race = resolveOption(config, 'races', selectedRoll?.race_key, player.raca || selectedRoll?.race);
    const socialClass = resolveOption(config, 'socialClasses', selectedRoll?.social_class_key, player.classe || selectedRoll?.social_class);
    const grimoire = resolveOption(config, 'grimoires', selectedRoll?.grimoire_key, player.grimorio || selectedRoll?.grimoire);
    const kingdom = resolveOption(config, 'kingdoms', selectedRoll?.kingdom_key, player.reino || selectedRoll?.kingdom);
    const family = buildFamilySummary(config, player, selectedRoll);
    const traits = buildTraitSummary(config, player);

    const raceKey = resolveFallbackKey(config, 'races', race, player.raca || selectedRoll?.race);
    const classKey = resolveFallbackKey(config, 'socialClasses', socialClass, player.classe || selectedRoll?.social_class);
    const grimoireKey = resolveFallbackKey(config, 'grimoires', grimoire, player.grimorio || selectedRoll?.grimoire);
    const human = raceKey === 'humano' || normalizeText(race?.name || player.raca) === 'humano';

    const raceMana = RACE_MANA[raceKey] ?? 0;
    const classMana = human ? (CLASS_MANA[classKey] ?? 0) : 0;
    const classIgnored = !human && isFilled(player.classe || selectedRoll?.social_class);
    const grimoireRule = resolveGrimoireRule(grimoireKey, grimoire?.name || player.grimorio || selectedRoll?.grimoire);
    const grimoireMana = grimoireRule.mana || 0;
    const baseMana = asNumber(player.mana);
    const totalMana = baseMana + raceMana + classMana + grimoireMana;
    const reservePercent = grimoireRule.reservePercent || 0;
    const reserveAmount = reservePercent ? Math.floor(totalMana * reservePercent / 100) : 0;
    const treeDiscounts = buildTreeDiscounts(classKey, grimoireKey);
    const treeDiscountLines = Object.values(treeDiscounts)
        .map(formatTreeDiscountLine)
        .filter(Boolean);
    const customBonuses = await getCustomCharacterBonuses(db, playerId).catch(() => []);
    const customAutomatic = customBonuses
        .filter(isAutomaticCustomBonus)
        .map(formatCustomBonusLine)
        .filter(Boolean);
    const customNotAutomatic = customBonuses
        .filter((row) => !isAutomaticCustomBonus(row))
        .map(formatCustomBonusLine)
        .filter(Boolean);

    const warnings = [];
    if (human && isFilled(player.classe || selectedRoll?.social_class) && !(classKey in CLASS_MANA)) {
        warnings.push('Classe humana sem mana fixa reconhecida na tabela.');
    }
    if (!raceKey || !(raceKey in RACE_MANA)) {
        warnings.push('Raca sem mana fixa reconhecida na tabela.');
    }

    return {
        ok: true,
        playerId,
        player,
        selectedRoll,
        identity: {
            name: display(player.personagem_nome || player.nome, 'Sem nome'),
            kingdom: display(kingdom?.name || player.reino || selectedRoll?.kingdom),
            race: display(race?.name || player.raca || selectedRoll?.race),
            socialClass: buildClassLabel(socialClass, player),
            family: family.label,
            grimoire: display(grimoire?.name || player.grimorio || selectedRoll?.grimoire),
            magic: display(player.magia),
        },
        keys: {
            kingdom: kingdom?.key || selectedRoll?.kingdom_key || toLookupKey(player.reino),
            race: raceKey,
            socialClass: classKey,
            grimoire: grimoireKey,
            family: family.key,
        },
        mana: {
            base: baseMana,
            race: raceMana,
            socialClass: classMana,
            grimoire: grimoireMana,
            total: totalMana,
            classIgnored,
        },
        reserve: {
            percent: reservePercent,
            amount: reserveAmount,
            label: reservePercent ? `${formatNumber(reserveAmount)} (${reservePercent}% Heart)` : '-',
        },
        automatic: [
            ...grimoireRule.automatic.map(cleanBonusText),
            ...treeDiscountLines,
            ...customAutomatic,
        ],
        notAutomatic: [
            ...(CLASS_EFFECTS[classKey] || []).filter((item) => !isTreeDiscountEffect(item)).map(cleanBonusText),
            ...grimoireRule.notAutomatic.filter((item) => !isTreeDiscountEffect(item)).map(cleanBonusText),
            ...family.notes,
            ...customNotAutomatic,
            'Bônus de família, salários, PM percentual, vantagens narrativas e traços não entram automaticamente nos números.',
            'Descontos de árvore entram automaticamente no custo da compra.',
        ].filter(Boolean),
        customBonuses: customBonuses.map((row) => ({
            id: row.id,
            name: row.name,
            type: row.type,
            value: row.value,
            description: row.description,
            status: row.status,
            source: row.source,
            reason: row.reason,
            expiresAt: row.expires_at,
            createdAt: row.created_at,
            automatic: isAutomaticCustomBonus(row),
        })),
        treeDiscounts,
        family,
        traits,
        warnings,
    };
}

function formatTraitLine(label, trait) {
    const value = cleanBonusText(display(trait?.label, 'Nenhuma'));
    const rarity = trait?.rarity ? ` (${trait.rarity})` : '';
    return `*${label}:* ${value}${rarity}`;
}

function formatStyledTraitLine(label, trait) {
    const labelMap = {
        Aptidão: '𝐀𝐩𝐭𝐢𝐝𝐚̃𝐨',
        Marca: '𝐌𝐚𝐫𝐜𝐚',
        Anomalia: '𝐀𝐧𝐨𝐦𝐚𝐥𝐢𝐚',
    };
    const value = cleanBonusText(display(trait?.label, 'Nenhuma'));
    const rarity = trait?.rarity ? ` — _${trait.rarity}_` : '';
    return `*${labelMap[label] || label}:* ${value}${rarity}`;
}

function lowerFirst(value) {
    const text = String(value || '').trim();
    return text ? `${text.charAt(0).toLowerCase()}${text.slice(1)}` : text;
}

function formatTraitDetailLine(line) {
    const text = cleanBonusText(line).trim();
    if (!text) return null;

    const match = text.match(/^([^:]+):\s*(.+)$/);
    if (match) {
        const labelKey = normalizeText(match[1]);
        const labelMap = {
            passivo: '𝐏𝐚𝐬𝐬𝐢𝐯𝐨',
            limite: '𝐋𝐢𝐦𝐢𝐭𝐞',
            desvantagem: '𝐃𝐞𝐬𝐯𝐚𝐧𝐭𝐚𝐠𝐞𝐦',
            'uso narrativo': '𝐔𝐬𝐨 𝐧𝐚𝐫𝐫𝐚𝐭𝐢𝐯𝐨',
        };
        if (labelMap[labelKey]) {
            return `> *${labelMap[labelKey]}:* ${match[2].trim()}`;
        }
    }

    const normalized = normalizeText(text);
    if (normalized.startsWith('nao ') || normalized.startsWith('nao controla') || normalized.startsWith('não ')) {
        return `> *𝐋𝐢𝐦𝐢𝐭𝐞:* ${lowerFirst(text)}`;
    }
    if (normalized.startsWith('1x por trama')) {
        return `> *𝐔𝐬𝐨 𝐧𝐚𝐫𝐫𝐚𝐭𝐢𝐯𝐨:* ${text}`;
    }

    return `> ${text}`;
}

function formatTraitDetailBlock(label, trait, fallback) {
    const lines = [formatStyledTraitLine(label, trait)];
    if (trait?.description?.summary) {
        lines.push(`> ${trait.description.summary}`);
    }

    const detailLines = Array.isArray(trait?.description?.lines)
        ? trait.description.lines.filter(Boolean)
        : [];

    if (detailLines.length) {
        lines.push(...detailLines.map(formatTraitDetailLine).filter(Boolean));
    } else {
        lines.push(`> ${fallback}`);
    }

    return lines;
}

function formatReserveBonusDisplay(summary) {
    const reserve = summary?.reserve || {};
    return reserve.percent
        ? `${formatNumber(reserve.amount)} — _${reserve.percent}% Heart_`
        : '-';
}

function formatStyledTreeLabel(label) {
    const normalized = normalizeText(label);
    const labels = {
        'arvore fisica': '𝐀́𝐫𝐯𝐨𝐫𝐞 𝐅𝐢́𝐬𝐢𝐜𝐚',
        'arvore de mana': '𝐀́𝐫𝐯𝐨𝐫𝐞 𝐝𝐞 𝐌𝐚𝐧𝐚',
        'arvore de suporte': '𝐀́𝐫𝐯𝐨𝐫𝐞 𝐝𝐞 𝐒𝐮𝐩𝐨𝐫𝐭𝐞',
        'arvore de criacao': '𝐀́𝐫𝐯𝐨𝐫𝐞 𝐝𝐞 𝐂𝐫𝐢𝐚𝐜̧𝐚̃𝐨',
        'arvore de reforco': '𝐀́𝐫𝐯𝐨𝐫𝐞 𝐝𝐞 𝐑𝐞𝐟𝐨𝐫𝐜̧𝐨',
    };
    return labels[normalized] || label;
}

function formatAutomaticBonusLines(summary) {
    const lines = [];
    if (summary.reserve.percent) {
        lines.push(`> *𝐑𝐞𝐬𝐞𝐫𝐯𝐚 𝐧𝐚𝐭𝐮𝐫𝐚𝐥:* ${summary.reserve.percent}% da Mana total.`);
    }

    for (const discount of Object.values(summary.treeDiscounts || {})) {
        const sources = [...new Set(discount.sources || [])].join(' + ');
        const sourceText = sources ? ` — _${sources}._` : '';
        lines.push(`> *${formatStyledTreeLabel(discount.label)}:* desconto automático de ${discount.percent}%${sourceText}`);
    }

    const extraLines = summary.automatic
        .map(cleanBonusText)
        .filter((item) => {
            const normalized = normalizeText(item);
            return item
                && !isTreeDiscountEffect(item)
                && !(normalized.includes('reserva') && normalized.includes('mana natural'));
        });

    lines.push(...extraLines.map((item) => `> ${item}`));
    return lines.length ? lines : ['> Apenas os valores fixos de mana acima entram automaticamente.'];
}

function formatNotAutomaticBonusLine(item) {
    const text = cleanBonusText(item).trim();
    const salaryMatch = text.match(/^Sal[aá]rio semanal de\s+(.+?)\.?$/i);
    if (salaryMatch) {
        return `> *𝐒𝐚𝐥𝐚́𝐫𝐢𝐨:* ${salaryMatch[1]} semanais.`;
    }

    const affinityMatch = text.match(/^Afinidade narrativa com\s+(.+?)\.?$/i);
    if (affinityMatch) {
        return `> *𝐀𝐟𝐢𝐧𝐢𝐝𝐚𝐝𝐞 𝐧𝐚𝐫𝐫𝐚𝐭𝐢𝐯𝐚:* ${affinityMatch[1]}.`;
    }

    return `> ${text}`;
}

function formatNotAutomaticBonusLines(summary) {
    const lines = summary.notAutomatic.length
        ? [...new Set(summary.notAutomatic.map(cleanBonusText))].filter(Boolean)
        : ['Nenhum efeito narrativo extra registrado.'];
    return lines.map(formatNotAutomaticBonusLine);
}

function formatProfileScaleLines(summary, capacity) {
    const pb = capacity.pb;
    const phSummary = capacity.ph;
    return [
        `*Estágio:* ${capacity.stageName}`,
        `*Mana total:* ${formatNumber(summary.mana.total)}`,
        `*Reserva de Mana:* ${summary.reserve.label}`,
        `*Poder Mágico:* ${capacity.poderMagico}`,
        `*PB:* ${pb.pbTotal} total - ${pb.free} livre`,
        `*PH disponível:* ${phSummary.phAvailable}`,
        `*PH acumulado:* ${phSummary.phAccumulated}`,
    ];
}

function formatProfileTraitLines(summary) {
    return [
        formatTraitLine('Aptidão', summary.traits.aptitude),
        formatTraitLine('Marca', summary.traits.mark),
        formatTraitLine('Anomalia', summary.traits.anomaly),
        `*Gancho Narrativo:* ${cleanBonusText(summary.traits.hook)}`,
        '',
        `Use *${COMMAND_PREFIX}bonus* para ver detalhes e efeitos que não entram automaticamente nos números.`,
    ];
}

function formatBonusMessage(summary) {
    if (!summary.ok) return summary.error;

    const manaClassLine = summary.mana.classIgnored
        ? `> Classe (${summary.identity.socialClass}): +0 (classe social so soma mana para Humanos)`
        : `> Classe (${summary.identity.socialClass}): +${formatNumber(summary.mana.socialClass)}`;

    const automaticLines = summary.automatic.length
        ? summary.automatic.map((item) => `> ${item}`)
        : ['> Apenas os valores fixos de mana acima entram automaticamente.'];

    const notAutomaticLines = summary.notAutomatic.length
        ? [...new Set(summary.notAutomatic)].map((item) => `> ${item}`)
        : ['> Nenhum efeito narrativo extra registrado.'];

    const warningLines = summary.warnings.length
        ? ['', '     --  AVISOS  --', '', ...summary.warnings.map((item) => `> ${item}`)]
        : [];

    const narrativeLines = summary.traits.narrativeExtras.length
        ? ['', '     --  GANCHOS NARRATIVOS  --', '', ...formatNarrativeExtras(summary.traits.narrativeExtras)]
        : [];

    return [
        '♧ BONUS DA FICHA',
        '     --  clover rpg · mana, reserva e efeitos registrados  --',
        '',
        '     --  PERSONAGEM  --',
        '',
        `*Nome:* ${summary.identity.name}`,
        `*Reino:* ${summary.identity.kingdom}`,
        `*Raca:* ${summary.identity.race}`,
        `*Classe:* ${summary.identity.socialClass}`,
        `*Familia:* ${summary.identity.family}`,
        `*Grimorio:* ${summary.identity.grimoire}`,
        `*Magia:* ${summary.identity.magic}`,
        '',
        '     --  MANA APLICADA  --',
        '',
        `> Mana base/manual: ${formatNumber(summary.mana.base)}`,
        `> Raca (${summary.identity.race}): +${formatNumber(summary.mana.race)}`,
        manaClassLine,
        `> Grimorio (${summary.identity.grimoire}): +${formatNumber(summary.mana.grimoire)}`,
        '',
        `*Mana total:* ${formatNumber(summary.mana.total)}`,
        `*Reserva de Mana:* ${summary.reserve.label}`,
        '',
        '     --  APLICADO AUTOMATICAMENTE  --',
        '',
        ...automaticLines,
        '',
        '     --  NAO AUTOMATICO  --',
        '',
        ...notAutomaticLines,
        '',
        '     --  TRACOS  --',
        '',
        formatTraitLine('Aptidao', summary.traits.aptitude),
        `> Efeito: use como talento natural e vantagem narrativa quando fizer sentido.`,
        '',
        formatTraitLine('Marca', summary.traits.mark),
        `> Efeito: use como marca de historia, consequencia ou leitura de personagem.`,
        '',
        formatTraitLine('Anomalia', summary.traits.anomaly),
        `> Efeito: depende do tipo de anomalia e da aprovacao narrativa quando for amplo.`,
        '',
        `*Gancho Narrativo:* ${summary.traits.hook}`,
        ...narrativeLines,
        ...warningLines,
        '',
        `Use *${COMMAND_PREFIX}perfil* para o resumo limpo do personagem.`,
    ].join('\n');
}

formatBonusMessage = function formatBonusMessage(summary) {
    if (!summary.ok) return summary.error;

    const manaClassLine = summary.mana.classIgnored
        ? `> *𝐂𝐥𝐚𝐬𝐬𝐞:* ${cleanBonusText(summary.identity.socialClass)} — +0 (classe social só soma mana para Humanos)`
        : `> *𝐂𝐥𝐚𝐬𝐬𝐞:* ${cleanBonusText(summary.identity.socialClass)} — +${formatNumber(summary.mana.socialClass)}`;

    const automaticLines = formatAutomaticBonusLines(summary);
    const notAutomaticLines = formatNotAutomaticBonusLines(summary);

    const warningLines = summary.warnings.length
        ? ['', '_`─( ! )───── 𝗔𝘃𝗶𝘀𝗼𝘀`_', '', ...summary.warnings.map((item) => `> ${cleanBonusText(item)}`)]
        : [];

    const narrativeLines = summary.traits.narrativeExtras.length
        ? ['', '_`─( ✧ )───── 𝗚𝗮𝗻𝗰𝗵𝗼𝘀 𝗡𝗮𝗿𝗿𝗮𝘁𝗶𝘃𝗼𝘀`_', '', ...formatNarrativeExtras(summary.traits.narrativeExtras)]
        : [];

    return [
        '♧┃𝐁𝐎̂𝐍𝐔𝐒 𝐃𝐀 𝐅𝐈𝐂𝐇𝐀 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫',
        '     ──  mαnα, rᥱsᥱrvα ᥱ ᥱfᥱıtos rᥱgıstrαdos  ──',
        '',
        '_`─( ✦ )───── 𝗠𝗮𝗻𝗮 𝗔𝗽𝗹𝗶𝗰𝗮𝗱𝗮`_',
        '',
        `> *𝐌𝐚𝐧𝐚 𝐛𝐚𝐬𝐞/𝐦𝐚𝐧𝐮𝐚𝐥:* ${formatNumber(summary.mana.base)}`,
        `> *𝐑𝐚𝐜̧𝐚:* ${cleanBonusText(summary.identity.race)} — +${formatNumber(summary.mana.race)}`,
        manaClassLine,
        `> *𝐆𝐫𝐢𝐦𝐨́𝐫𝐢𝐨:* ${cleanBonusText(summary.identity.grimoire)} — +${formatNumber(summary.mana.grimoire)}`,
        '',
        `*𝐌𝐚𝐧𝐚 𝐭𝐨𝐭𝐚𝐥:* ${formatNumber(summary.mana.total)}`,
        `*𝐑𝐞𝐬𝐞𝐫𝐯𝐚 𝐝𝐞 𝐌𝐚𝐧𝐚:* ${formatReserveBonusDisplay(summary)}`,
        '',
        '_`─( ◆ )───── 𝗘𝗳𝗲𝗶𝘁𝗼𝘀 𝗔𝘂𝘁𝗼𝗺𝗮́𝘁𝗶𝗰𝗼𝘀`_',
        '',
        ...automaticLines,
        '',
        '_`─( ◇ )───── 𝗘𝗳𝗲𝗶𝘁𝗼𝘀 𝗡𝗮̃𝗼 𝗔𝘂𝘁𝗼𝗺𝗮́𝘁𝗶𝗰𝗼𝘀`_',
        '',
        ...notAutomaticLines,
        '',
        '_`─( ♢ )───── 𝗧𝗿𝗮𝗰̧𝗼𝘀`_',
        '',
        ...formatTraitDetailBlock(
            'Aptidão',
            summary.traits.aptitude,
            'Efeito personalizado ou não reconhecido no sistema oficial. Use como talento natural quando fizer sentido.'
        ),
        '',
        ...formatTraitDetailBlock(
            'Marca',
            summary.traits.mark,
            'Efeito personalizado ou não reconhecido no sistema oficial. Use como marca de história, consequência ou leitura de personagem.'
        ),
        '',
        ...formatTraitDetailBlock(
            'Anomalia',
            summary.traits.anomaly,
            'Efeitos anômalos dependem do tipo de anomalia e da aprovação narrativa quando forem amplos.'
        ),
        '',
        `*𝐆𝐚𝐧𝐜𝐡𝐨 𝐍𝐚𝐫𝐫𝐚𝐭𝐢𝐯𝐨:* ${summary.traits.hook}`,
        ...narrativeLines,
        ...warningLines,
        '',
        '_`─( ■ )───── 𝗥𝗲𝘀𝘂𝗺𝗼`_',
        '',
        `Use *${COMMAND_PREFIX}perfil* para ver o resumo limpo do personagem.`,
    ].join('\n');
};

module.exports = {
    CLASS_MANA,
    CLASS_TREE_DISCOUNTS,
    GRIMOIRE_TREE_DISCOUNTS,
    GRIMOIRE_RULES,
    RACE_MANA,
    TREE_LABELS,
    applyTreeDiscountCost,
    ensureCharacterBonusSchema,
    formatBonusMessage,
    formatNumber,
    formatProfileScaleLines,
    formatProfileTraitLines,
    getCharacterBonusSummary,
    getCustomCharacterBonuses,
    getTreeDiscountForPlayer,
};
