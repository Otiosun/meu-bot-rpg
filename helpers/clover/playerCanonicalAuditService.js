'use strict';

const PROFILE_TRAIT_FIELDS = Object.freeze([
    ['aptidao_comum', 'aptidao_comum_key'],
    ['aptidao_rara', 'aptidao_rara_key'],
    ['marca_comum', 'marca_comum_key'],
    ['marca_rara', 'marca_rara_key'],
    ['anomalia', 'anomalia_key'],
]);

function normalizeText(value) {
    return String(value ?? '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

function digits(value) {
    return String(value ?? '').replace(/\D/g, '');
}

function nonEmpty(value) {
    const text = String(value ?? '').trim();
    return Boolean(text) && !['-', '—', 'n/a', 'null', 'undefined'].includes(text.toLowerCase());
}

function normalizeStatus(value) {
    return normalizeText(value).replace(/ /g, '_');
}

function playerDisplayName(player = {}) {
    return [player.personagem_nome, player.display_name, player.nome, player.nome_real]
        .map((value) => String(value || '').trim())
        .find(nonEmpty) || String(player.id || 'Sem identificação');
}

function playerNames(player = {}) {
    return [player.personagem_nome, player.display_name, player.nome, player.nome_real]
        .filter(nonEmpty)
        .map(normalizeText)
        .filter(Boolean);
}

function playerIsActive(player = {}) {
    return normalizeStatus(player.jogo_status) === 'liberado';
}

function playerIsApproved(player = {}) {
    return ['aprovada', 'aprovado', 'confirmada', 'confirmado']
        .includes(normalizeStatus(player.ficha_status));
}

function identityAliases(entry = {}) {
    return [...new Set([
        entry.referenceName,
        ...(entry.identityHints?.aliases || []),
    ].filter(Boolean).map(normalizeText).filter(Boolean))];
}

function scoreIdentityCandidate(player, entry) {
    const aliases = identityAliases(entry);
    const names = playerNames(player);
    const suffix = digits(entry.identityHints?.phoneSuffix);
    const playerDigits = digits(player.id);
    let score = 0;
    const reasons = [];

    if (suffix && playerDigits.endsWith(suffix)) {
        score += suffix.length >= 8 ? 1200 : 900;
        reasons.push(`telefone termina em ${suffix}`);
    }

    for (const alias of aliases) {
        if (names.includes(alias)) {
            score += alias === normalizeText(entry.referenceName) ? 600 : 500;
            reasons.push(`nome exato: ${alias}`);
            continue;
        }
        if (alias.length >= 4 && names.some((name) => name.includes(alias) || alias.includes(name))) {
            score += 160;
            reasons.push(`nome parcial: ${alias}`);
        }
    }

    if (playerIsActive(player)) {
        score += 40;
        reasons.push('jogo liberado');
    }
    if (playerIsApproved(player)) {
        score += 20;
        reasons.push('ficha aprovada');
    }

    return { player, score, reasons: [...new Set(reasons)] };
}

function resolvePlayer(players, entry) {
    const ranked = players
        .map((player) => scoreIdentityCandidate(player, entry))
        .filter((candidate) => candidate.score > 0)
        .sort((left, right) => right.score - left.score || String(left.player.id).localeCompare(String(right.player.id)));

    if (!ranked.length || ranked[0].score < 160) {
        return {
            status: 'unresolved',
            selected: null,
            candidates: ranked.slice(0, 5).map(compactCandidate),
            reason: 'Nenhum cadastro atingiu confiança suficiente.',
        };
    }

    const top = ranked[0];
    const second = ranked[1];
    const ambiguous = second && second.score >= top.score - 25;
    if (ambiguous) {
        return {
            status: 'ambiguous',
            selected: null,
            candidates: ranked.slice(0, 5).map(compactCandidate),
            reason: 'Mais de um cadastro possui pontuação equivalente.',
        };
    }

    return {
        status: 'resolved',
        selected: top.player,
        confidence: top.score >= 900 ? 'high' : top.score >= 500 ? 'medium' : 'review',
        score: top.score,
        reasons: top.reasons,
        candidates: ranked.slice(0, 5).map(compactCandidate),
    };
}

function compactCandidate(candidate) {
    return {
        playerId: candidate.player.id,
        name: playerDisplayName(candidate.player),
        jogoStatus: candidate.player.jogo_status || null,
        fichaStatus: candidate.player.ficha_status || null,
        score: candidate.score,
        reasons: candidate.reasons,
    };
}

async function tableExists(db, table) {
    const row = await db.get(
        'SELECT 1 AS found FROM sqlite_master WHERE type = ? AND name = ?',
        ['table', table]
    );
    return Boolean(row?.found);
}

async function rowsForPlayer(db, table, playerId, columns = ['player_id']) {
    if (!await tableExists(db, table)) return [];
    for (const column of columns) {
        const info = await db.all(`PRAGMA table_info("${String(table).replace(/"/g, '""')}")`);
        if (!info.some((item) => item.name === column)) continue;
        return db.all(
            `SELECT * FROM "${String(table).replace(/"/g, '""')}" WHERE "${String(column).replace(/"/g, '""')}" = ? ORDER BY rowid ASC`,
            [playerId]
        ).catch(() => []);
    }
    return [];
}

function compactInventory(items) {
    return items.map((item) => ({
        id: item.id ?? null,
        templateKey: item.template_key ?? null,
        name: item.item_name ?? item.name ?? null,
        description: item.description ?? null,
        category: item.category ?? null,
        kind: item.kind ?? null,
        quantity: item.quantity ?? null,
        status: item.status ?? null,
    }));
}

function compactAttempts(rows) {
    return rows.map((row) => ({
        id: row.id ?? null,
        category: row.category ?? null,
        result: row.result ?? row.status ?? null,
        chosenKey: row.chosen_key ?? null,
        attempt: row.attempt_number ?? null,
    }));
}

function compactSkills(rows) {
    return rows.map((row) => ({
        id: row.id ?? null,
        treeId: row.tree_id ?? row.tree ?? null,
        nodeId: row.node_id ?? null,
        purchasedAt: row.purchased_at ?? null,
    }));
}

function traitSnapshot(player) {
    return PROFILE_TRAIT_FIELDS.map(([labelField, keyField]) => ({
        labelField,
        keyField,
        label: player[labelField] ?? null,
        key: player[keyField] ?? null,
    })).filter((entry) => nonEmpty(entry.label) || nonEmpty(entry.key));
}

function buildCorpus(player, inventory, attempts, skills) {
    const values = [];
    for (const [key, value] of Object.entries(player || {})) {
        if (typeof value === 'string' && value.length <= 20000) values.push(`${key} ${value}`);
    }
    for (const item of inventory) values.push(`${item.name || ''} ${item.description || ''}`);
    for (const attempt of attempts) values.push(`${attempt.category || ''} ${attempt.chosenKey || ''}`);
    for (const skill of skills) values.push(`${skill.treeId || ''} ${skill.nodeId || ''}`);
    return normalizeText(values.join('\n'));
}

function textPresence(corpus, title, text = '') {
    const titleKey = normalizeText(title);
    const textKey = normalizeText(text);
    if (titleKey && corpus.includes(titleKey)) return 'title_present';
    if (textKey && textKey.length >= 40) {
        const excerpt = textKey.split(' ').slice(0, 12).join(' ');
        if (excerpt && corpus.includes(excerpt)) return 'text_present';
    }
    return 'missing';
}

function systemTraitPresence(traits, acceptableLabels) {
    const expected = acceptableLabels.map(normalizeText).filter(Boolean);
    const found = traits.flatMap((trait) => [trait.label, trait.key]).map(normalizeText).filter(Boolean);
    const matched = acceptableLabels.find((label) => found.includes(normalizeText(label))) || null;
    return {
        status: matched ? 'present' : 'missing',
        acceptableLabels,
        matched,
        currentTraits: traits,
    };
}

function identifyRiskFlags(entry) {
    const flags = [];
    for (const trait of entry.customTraits || []) {
        if (trait.review) flags.push({ type: 'mechanical_review', entry: trait.title, reason: trait.review });
        const normalized = normalizeText(trait.text);
        if (/minimizando completamente|ignora penalidades|todas as acoes|quebrando|com facilidade/.test(normalized)) {
            flags.push({ type: 'strong_wording', entry: trait.title, reason: 'A redação contém efeito amplo ou absoluto.' });
        }
    }
    for (const item of entry.narrativeItems || []) {
        if (item.status === 'provisional_title') flags.push({ type: 'provisional_title', entry: item.title });
    }
    for (const hook of entry.narrativeHooks || []) {
        if (hook.status === 'provisional_title') flags.push({ type: 'provisional_title', entry: hook.title });
    }
    return flags;
}

function buildRecommendations({ entry, resolution, player, systemTrait, customTraits, hooks, items, riskFlags }) {
    const actions = [];
    if (resolution.status !== 'resolved') {
        actions.push({ priority: 'blocker', action: 'resolve_identity', detail: resolution.reason });
        return actions;
    }
    if (!playerIsActive(player)) {
        actions.push({ priority: 'review', action: 'confirm_active_player', detail: `jogo_status=${player.jogo_status || 'vazio'}` });
    }
    if ((entry.systemTraits || []).length && systemTrait.status === 'missing') {
        actions.push({ priority: 'review', action: 'link_system_trait', detail: entry.systemTraits.join(' / ') });
    }
    for (const item of customTraits.filter((value) => value.presence === 'missing')) {
        actions.push({ priority: 'review', action: 'register_custom_trait', detail: item.title });
    }
    for (const hook of hooks.filter((value) => value.presence === 'missing')) {
        actions.push({ priority: 'review', action: 'register_narrative_hook', detail: hook.title });
    }
    for (const item of items.filter((value) => value.presence === 'missing')) {
        actions.push({ priority: 'review', action: 'register_narrative_item', detail: item.title });
    }
    for (const flag of riskFlags) {
        actions.push({ priority: 'review', action: flag.type, detail: `${flag.entry}${flag.reason ? ` — ${flag.reason}` : ''}` });
    }
    return actions;
}

async function inspectResolvedPlayer(db, entry, resolution) {
    const player = resolution.selected;
    const playerId = player.id;
    const [inventoryRows, attemptRows, skillRows, legacyRows] = await Promise.all([
        rowsForPlayer(db, 'clover_inventory_items', playerId),
        rowsForPlayer(db, 'clover_trait_attempts', playerId),
        rowsForPlayer(db, 'clover_skill_nodes', playerId),
        rowsForPlayer(db, 'player_skill_trees', playerId),
    ]);

    const inventory = compactInventory(inventoryRows);
    const attempts = compactAttempts(attemptRows);
    const skills = compactSkills(skillRows);
    const traits = traitSnapshot(player);
    const corpus = buildCorpus(player, inventory, attempts, skills);
    const systemTrait = systemTraitPresence(traits, entry.systemTraits || []);
    const customTraits = (entry.customTraits || []).map((item) => ({
        ...item,
        presence: textPresence(corpus, item.title, item.text),
    }));
    const hooks = (entry.narrativeHooks || []).map((item) => ({
        ...item,
        presence: textPresence(corpus, item.title, item.text),
    }));
    const narrativeItems = (entry.narrativeItems || []).map((item) => ({
        ...item,
        presence: textPresence(corpus, item.title, item.description),
    }));
    const riskFlags = identifyRiskFlags(entry);

    const snapshot = {
        playerId,
        canonicalPlayerId: player.canonical_player_id || playerId,
        name: playerDisplayName(player),
        active: playerIsActive(player),
        approved: playerIsApproved(player),
        fichaStatus: player.ficha_status || null,
        jogoStatus: player.jogo_status || null,
        historiaStatus: player.historia_status || null,
        squad: player.esquadrao || player.esquadrao_key || null,
        profile: {
            race: player.raca || null,
            class: player.classe || null,
            grimoire: player.grimorio || null,
            magic: player.magia || null,
            narrativeHook: player.gancho_narrativo || null,
            extraStories: player.historias_extras || null,
        },
        traits,
        attempts,
        inventory,
        skills,
        legacyTrees: legacyRows,
    };

    return {
        referenceName: entry.referenceName,
        resolution: {
            status: resolution.status,
            confidence: resolution.confidence,
            score: resolution.score,
            reasons: resolution.reasons,
            candidates: resolution.candidates,
        },
        snapshot,
        intended: {
            systemTrait,
            customTraits,
            narrativeHooks: hooks,
            narrativeItems,
            notes: entry.notes || [],
        },
        riskFlags,
        recommendations: buildRecommendations({
            entry,
            resolution,
            player,
            systemTrait,
            customTraits,
            hooks,
            items: narrativeItems,
            riskFlags,
        }),
    };
}

async function auditCanonicalPlayerBatch(db, manifest) {
    if (!manifest || manifest.readOnly !== true || !Array.isArray(manifest.players)) {
        throw new Error('Manifesto canônico inválido ou sem marcação readOnly.');
    }
    if (!await tableExists(db, 'jogadores')) throw new Error('Tabela jogadores não encontrada.');

    const players = await db.all('SELECT * FROM jogadores ORDER BY id ASC');
    const results = [];

    for (const entry of manifest.players) {
        const resolution = resolvePlayer(players, entry);
        if (resolution.status !== 'resolved') {
            results.push({
                referenceName: entry.referenceName,
                resolution,
                snapshot: null,
                intended: entry,
                riskFlags: identifyRiskFlags(entry),
                recommendations: buildRecommendations({
                    entry,
                    resolution,
                    player: null,
                    systemTrait: { status: 'unknown' },
                    customTraits: [],
                    hooks: [],
                    items: [],
                    riskFlags: identifyRiskFlags(entry),
                }),
            });
            continue;
        }
        results.push(await inspectResolvedPlayer(db, entry, resolution));
    }

    const summary = {
        batch: manifest.batch || null,
        requestedPlayers: manifest.players.length,
        resolved: results.filter((item) => item.resolution.status === 'resolved').length,
        unresolved: results.filter((item) => item.resolution.status === 'unresolved').length,
        ambiguous: results.filter((item) => item.resolution.status === 'ambiguous').length,
        activeResolved: results.filter((item) => item.snapshot?.active).length,
        recommendations: results.reduce((sum, item) => sum + item.recommendations.length, 0),
        blockers: results.reduce((sum, item) => sum + item.recommendations.filter((action) => action.priority === 'blocker').length, 0),
        readOnly: true,
    };

    return {
        generatedAt: new Date().toISOString(),
        readOnly: true,
        manifestVersion: manifest.version || 1,
        source: manifest.source || null,
        summary,
        players: results,
    };
}

module.exports = {
    auditCanonicalPlayerBatch,
    buildCorpus,
    normalizeText,
    playerDisplayName,
    resolvePlayer,
    scoreIdentityCandidate,
    systemTraitPresence,
    textPresence,
};
