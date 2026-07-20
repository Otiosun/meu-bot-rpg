'use strict';

const { listTrees } = require('./treeLoader');

const PLACEHOLDERS = new Set([
    '', '-', '—', '–', 'null', 'undefined', 'nao informado', 'não informado',
    'nao registrado', 'não registrado', 'sem registro', 'n/a', '[]', '{}',
]);

const ACTIVE_ITEM_STATUSES = new Set([
    'disponivel', 'reservado', 'equipado', 'em_uso', 'active',
]);

const TRAIT_FIELDS = Object.freeze([
    ['aptidao_comum', 'aptidao_comum_key', 'aptidão comum'],
    ['aptidao_rara', 'aptidao_rara_key', 'aptidão rara'],
    ['marca_comum', 'marca_comum_key', 'marca comum'],
    ['marca_rara', 'marca_rara_key', 'marca rara'],
    ['anomalia', 'anomalia_key', 'anomalia'],
]);

const SUCCESS_ATTEMPT_FIELDS = Object.freeze({
    rare_aptitude: ['aptidao_rara', 'aptidao_rara_key', 'aptidão rara'],
    rare_mark: ['marca_rara', 'marca_rara_key', 'marca rara'],
    anomaly: ['anomalia', 'anomalia_key', 'anomalia'],
});

const PROFILE_FIELDS = Object.freeze([
    ['personagem_nome', 'nome do personagem'],
    ['raca', 'raça'],
    ['classe', 'classe'],
    ['grimorio', 'grimório'],
    ['magia', 'magia'],
]);

function normalizeText(value) {
    return String(value ?? '').trim();
}

function normalizeKey(value) {
    return normalizeText(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function isPlaceholder(value) {
    return PLACEHOLDERS.has(normalizeText(value).toLowerCase());
}

function hasEncodingDamage(value) {
    const text = normalizeText(value);
    if (!text) return false;
    return /\uFFFD|Ã.|Â.|â[€™œ“”]|[A-Za-zÀ-ÿ]\?[A-Za-zÀ-ÿ]/u.test(text);
}

function hasUnsafeControl(value) {
    const text = String(value ?? '');
    return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text);
}

function parseJson(value) {
    if (value === null || value === undefined || value === '') {
        return { ok: true, value: null };
    }
    if (typeof value === 'object') return { ok: true, value };
    try {
        return { ok: true, value: JSON.parse(String(value)) };
    } catch (error) {
        return { ok: false, error: error.message };
    }
}

function issue({
    severity = 'review',
    category,
    code,
    player = null,
    field = null,
    entity = null,
    current = null,
    detail,
    suggestedAction,
}) {
    return {
        severity,
        category,
        code,
        playerId: player?.id || null,
        characterName: player ? playerName(player) : null,
        field,
        entity,
        current,
        detail,
        suggestedAction,
    };
}

function playerName(player = {}) {
    return [player.personagem_nome, player.display_name, player.nome]
        .map(normalizeText)
        .find((value) => !isPlaceholder(value)) || 'Sem personagem registrado';
}

function normalizeStatus(value) {
    return normalizeText(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
}

function activePlayer(player) {
    return normalizeStatus(player.jogo_status) === 'liberado';
}

function approvedProfile(player) {
    return ['aprovada', 'aprovado', 'confirmada', 'confirmado']
        .includes(normalizeStatus(player.ficha_status));
}

async function tableExists(db, table) {
    const row = await db.get(
        `SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?`,
        [table]
    );
    return Boolean(row?.found);
}

async function tableColumns(db, table) {
    if (!await tableExists(db, table)) return new Set();
    const rows = await db.all(`PRAGMA table_info(${table})`);
    return new Set(rows.map((row) => row.name));
}

function auditText({ issues, category, code, player, field, entity, value }) {
    if (hasEncodingDamage(value)) {
        issues.push(issue({
            severity: 'warning', category, code: `${code}_encoding`, player, field, entity,
            current: normalizeText(value).slice(0, 240),
            detail: 'O texto contém sinais de codificação danificada ou caracteres substituídos.',
            suggestedAction: 'Comparar com backup ou fonte canônica antes de regravar o texto.',
        }));
    }
    if (hasUnsafeControl(value)) {
        issues.push(issue({
            severity: 'warning', category, code: `${code}_control_character`, player, field, entity,
            current: normalizeText(value).slice(0, 240),
            detail: 'O texto contém caractere de controle invisível.',
            suggestedAction: 'Limpar apenas o caractere invisível após revisar o conteúdo original.',
        }));
    }
}

function auditPlayerProfile(player, issues) {
    const strict = activePlayer(player) || approvedProfile(player);
    for (const [field, label] of PROFILE_FIELDS) {
        const value = player[field];
        auditText({ issues, category: 'profile', code: 'profile_text', player, field, value });
        if (strict && isPlaceholder(value)) {
            issues.push(issue({
                severity: activePlayer(player) ? 'warning' : 'review',
                category: 'profile', code: 'profile_required_missing', player, field,
                current: value,
                detail: `${label} está vazio apesar de a ficha estar aprovada ou o jogo liberado.`,
                suggestedAction: 'Comparar cadastro atual com backups e com a ficha aprovada.',
            }));
        }
    }

    for (const field of [
        'familia', 'formas', 'historia', 'aparencia', 'personagem_aparencia',
        'gancho_narrativo', 'historias_extras',
    ]) {
        if (Object.hasOwn(player, field)) {
            auditText({ issues, category: field === 'gancho_narrativo' ? 'narrative_hook' : 'profile', code: field, player, field, value: player[field] });
        }
    }

    if (activePlayer(player) && isPlaceholder(player.gancho_narrativo)) {
        issues.push(issue({
            severity: 'review', category: 'narrative_hook', code: 'hook_missing', player,
            field: 'gancho_narrativo', current: player.gancho_narrativo,
            detail: 'O personagem está liberado, mas não possui gancho narrativo registrado.',
            suggestedAction: 'Confirmar se o personagem realmente não possui gancho ou se o texto se perdeu.',
        }));
    }

    const extras = parseJson(player.historias_extras);
    if (Object.hasOwn(player, 'historias_extras') && !extras.ok) {
        issues.push(issue({
            severity: 'warning', category: 'narrative_hook', code: 'extra_stories_invalid_json', player,
            field: 'historias_extras', current: normalizeText(player.historias_extras).slice(0, 240),
            detail: 'O histórico de histórias extras não é JSON válido.',
            suggestedAction: 'Recuperar o JSON pelo backup; não substituir por lista vazia sem comparação.',
        }));
    }
}

function auditTraitPairs(player, attempts, issues) {
    for (const [labelField, keyField, label] of TRAIT_FIELDS) {
        const labelValue = player[labelField];
        const keyValue = player[keyField];
        auditText({ issues, category: 'traits', code: 'trait_text', player, field: labelField, value: labelValue });
        const hasLabel = !isPlaceholder(labelValue);
        const hasKey = !isPlaceholder(keyValue);
        if (hasLabel !== hasKey) {
            issues.push(issue({
                severity: 'warning', category: 'traits', code: 'trait_label_key_mismatch', player,
                field: `${labelField}/${keyField}`,
                current: { label: labelValue, key: keyValue },
                detail: `${label} possui somente texto ou somente chave canônica.`,
                suggestedAction: 'Resolver a opção no catálogo e preencher apenas o lado ausente.',
            }));
        }
    }

    for (const attempt of attempts || []) {
        if (normalizeStatus(attempt.result) !== 'success') continue;
        const mapping = SUCCESS_ATTEMPT_FIELDS[attempt.category];
        if (!mapping) continue;
        const [labelField, keyField, label] = mapping;
        if ((activePlayer(player) || approvedProfile(player))
            && isPlaceholder(player[labelField]) && isPlaceholder(player[keyField])) {
            issues.push(issue({
                severity: 'warning', category: 'traits', code: 'successful_trait_not_chosen', player,
                field: `${labelField}/${keyField}`, entity: `attempt:${attempt.attempt_number}`,
                current: { result: attempt.result, chosenKey: attempt.chosen_key },
                detail: `O sorteio de ${label} foi marcado como sucesso, mas a ficha aprovada não possui escolha registrada.`,
                suggestedAction: 'Confirmar a escolha do jogador e registrar texto e chave sem refazer o sorteio.',
            }));
        }
        if (!isPlaceholder(attempt.chosen_key)
            && !isPlaceholder(player[keyField])
            && normalizeKey(attempt.chosen_key) !== normalizeKey(player[keyField])) {
            issues.push(issue({
                severity: 'warning', category: 'traits', code: 'trait_attempt_choice_diverged', player,
                field: keyField, entity: `attempt:${attempt.attempt_number}`,
                current: { attempt: attempt.chosen_key, player: player[keyField] },
                detail: `A escolha registrada na tentativa de ${label} diverge da chave atual da ficha.`,
                suggestedAction: 'Comparar o momento da escolha e a última atualização autorizada da ficha.',
            }));
        }
    }

    const specialAttempts = parseJson(player.tentativas_especiais);
    if (Object.hasOwn(player, 'tentativas_especiais') && !specialAttempts.ok) {
        issues.push(issue({
            severity: 'warning', category: 'traits', code: 'special_attempts_invalid_json', player,
            field: 'tentativas_especiais', current: normalizeText(player.tentativas_especiais).slice(0, 240),
            detail: 'O registro legado das tentativas especiais não é JSON válido.',
            suggestedAction: 'Comparar com clover_trait_attempts e backup antes de reconstruir.',
        }));
    }
}

function auditJsonField({ issues, category, code, player, field, entity, value }) {
    const parsed = parseJson(value);
    if (!parsed.ok) {
        issues.push(issue({
            severity: 'warning', category, code, player, field, entity,
            current: normalizeText(value).slice(0, 240),
            detail: `${field} não contém JSON válido.`,
            suggestedAction: 'Recuperar a estrutura pelo histórico ou backup antes de substituir.',
        }));
    }
    return parsed;
}

function auditInventoryItem(item, player, template, issues) {
    const entity = `inventory:${item.id}`;
    auditText({ issues, category: 'items', code: 'item_name', player, field: 'item_name', entity, value: item.item_name });
    auditText({ issues, category: 'items', code: 'item_description', player, field: 'description', entity, value: item.description });

    if (isPlaceholder(item.item_name)) {
        issues.push(issue({
            severity: 'warning', category: 'items', code: 'item_name_missing', player,
            field: 'item_name', entity, current: item.item_name,
            detail: 'O exemplar não possui nome utilizável.',
            suggestedAction: 'Recuperar o nome pelo modelo, histórico de concessão ou backup.',
        }));
    }
    if (!Number.isInteger(Number(item.quantity)) || Number(item.quantity) <= 0) {
        issues.push(issue({
            severity: 'critical', category: 'items', code: 'item_quantity_invalid', player,
            field: 'quantity', entity, current: item.quantity,
            detail: 'A quantidade do exemplar é inválida.',
            suggestedAction: 'Revisar o histórico do item antes de corrigir a quantidade.',
        }));
    }
    if (isPlaceholder(item.category) || isPlaceholder(item.kind)) {
        issues.push(issue({
            severity: 'review', category: 'items', code: 'item_classification_missing', player,
            field: 'category/kind', entity,
            current: { category: item.category, kind: item.kind },
            detail: 'O item não está classificado de forma suficiente para site, mercado e raids.',
            suggestedAction: 'Classificar o exemplar sem alterar seus efeitos ou conceito.',
        }));
    }

    const current = item.durability_current;
    const maximum = item.durability_max;
    if ((current === null) !== (maximum === null)) {
        issues.push(issue({
            severity: 'warning', category: 'items', code: 'item_durability_partial', player,
            field: 'durability_current/durability_max', entity, current: { current, maximum },
            detail: 'Somente um lado da durabilidade está registrado.',
            suggestedAction: 'Confirmar se o item é durável e recuperar o outro valor.',
        }));
    }
    if (current !== null && maximum !== null) {
        if (Number(current) < 0 || Number(maximum) <= 0) {
            issues.push(issue({
                severity: 'critical', category: 'items', code: 'item_durability_invalid', player,
                field: 'durability_current/durability_max', entity, current: { current, maximum },
                detail: 'A durabilidade possui valor impossível.',
                suggestedAction: 'Comparar desgaste e reparos antes de ajustar.',
            }));
        } else if (Number(current) > Number(maximum)) {
            issues.push(issue({
                severity: 'warning', category: 'items', code: 'item_durability_above_max', player,
                field: 'durability_current/durability_max', entity, current: { current, maximum },
                detail: 'A durabilidade atual excede a durabilidade máxima.',
                suggestedAction: 'Verificar aprimoramento, reparo ou migração antes de limitar o valor.',
            }));
        }
    }

    for (const field of ['properties_json', 'effects_json', 'metadata_json']) {
        if (Object.hasOwn(item, field)) {
            auditJsonField({ issues, category: 'items', code: `item_${field}_invalid`, player, field, entity, value: item[field] });
        }
    }

    if (!isPlaceholder(item.template_key) && !template) {
        issues.push(issue({
            severity: 'warning', category: 'items', code: 'item_template_missing', player,
            field: 'template_key', entity, current: item.template_key,
            detail: 'O exemplar aponta para um modelo inexistente no catálogo atual.',
            suggestedAction: 'Recuperar o modelo ou desvincular somente após confirmar que o item é personalizado.',
        }));
    }
    if (template && normalizeText(template.item_name)
        && normalizeKey(template.item_name) !== normalizeKey(item.item_name)) {
        issues.push(issue({
            severity: 'review', category: 'items', code: 'item_name_diverged_from_template', player,
            field: 'item_name', entity,
            current: { item: item.item_name, template: template.item_name },
            detail: 'O nome do exemplar diverge do modelo. Pode ser personalização legítima ou migração incompleta.',
            suggestedAction: 'Preservar nomes personalizados; revisar apenas divergências sem intenção narrativa.',
        }));
    }
}

function auditTreeCatalog(issues) {
    let trees;
    try {
        trees = listTrees();
    } catch (error) {
        issues.push(issue({
            severity: 'critical', category: 'capabilities', code: 'tree_catalog_unreadable',
            detail: `O catálogo de capacidades não pôde ser carregado: ${error.message}`,
            suggestedAction: 'Corrigir o catálogo antes de avaliar capacidades individuais.',
        }));
        return new Map();
    }

    const catalog = new Map();
    for (const tree of trees) {
        const nodes = new Map();
        for (const node of tree.nodes || []) {
            nodes.set(node.id, node);
            for (const [field, value] of [['shortEffect', node.shortEffect], ['effect', node.effect]]) {
                if (isPlaceholder(value) || normalizeText(value).length < 12) {
                    issues.push(issue({
                        severity: 'review', category: 'capabilities', code: 'capacity_text_weak',
                        field, entity: `${tree.id}:${node.id}`, current: value,
                        detail: `O texto de ${node.name} é ausente ou curto demais para traduzir a capacidade ao jogador.`,
                        suggestedAction: 'Reescrever o texto funcional preservando exatamente o efeito e as travas do nó.',
                    }));
                }
                auditText({ issues, category: 'capabilities', code: 'capacity_text', field, entity: `${tree.id}:${node.id}`, value });
            }
        }
        catalog.set(tree.id, nodes);
    }
    return catalog;
}

function auditSkillNode(row, player, catalog, issues) {
    const tree = catalog.get(row.tree_id);
    if (!tree) {
        issues.push(issue({
            severity: 'critical', category: 'capabilities', code: 'owned_tree_unknown', player,
            field: 'tree_id', entity: `skill:${row.id}`, current: row.tree_id,
            detail: 'O jogador possui compra em uma árvore inexistente no catálogo.',
            suggestedAction: 'Comparar o ID antigo com aliases e migrações antes de mover a compra.',
        }));
        return;
    }
    if (!tree.has(row.node_id)) {
        issues.push(issue({
            severity: 'critical', category: 'capabilities', code: 'owned_node_unknown', player,
            field: 'node_id', entity: `skill:${row.id}`, current: row.node_id,
            detail: 'O jogador possui um nó comprado que não existe mais na árvore atual.',
            suggestedAction: 'Mapear o nó legado para o sucessor correto sem cobrar PH novamente.',
        }));
    }
    auditJsonField({
        issues, category: 'capabilities', code: 'skill_metadata_invalid', player,
        field: 'metadata_json', entity: `skill:${row.id}`, value: row.metadata_json,
    });
}

function auditLegacyTreeRow(row, player, catalog, issues) {
    const entity = `legacy-tree:${row.tree}`;
    const parsed = auditJsonField({
        issues, category: 'capabilities', code: 'legacy_unlocked_nodes_invalid', player,
        field: 'unlocked_node_ids', entity, value: row.unlocked_node_ids,
    });
    for (const field of ['narrative_flags', 'last_prox_options', 'purchase_history']) {
        auditJsonField({ issues, category: 'capabilities', code: `legacy_${field}_invalid`, player, field, entity, value: row[field] });
    }
    if (!parsed.ok || !Array.isArray(parsed.value)) return;
    const tree = catalog.get(row.tree);
    if (!tree) {
        if (parsed.value.length) {
            issues.push(issue({
                severity: 'warning', category: 'capabilities', code: 'legacy_tree_unknown', player,
                field: 'tree', entity, current: row.tree,
                detail: 'O registro legado possui nós em uma árvore inexistente.',
                suggestedAction: 'Mapear a árvore legada antes de remover esse registro.',
            }));
        }
        return;
    }
    for (const nodeId of parsed.value) {
        if (!tree.has(nodeId)) {
            issues.push(issue({
                severity: 'warning', category: 'capabilities', code: 'legacy_node_unknown', player,
                field: 'unlocked_node_ids', entity, current: nodeId,
                detail: 'O registro legado contém um nó que não existe no catálogo atual.',
                suggestedAction: 'Comparar com clover_skill_nodes e histórico de compras.',
            }));
        }
    }
}

function buildSummary(issues, players) {
    const bySeverity = { critical: 0, warning: 0, review: 0 };
    const byCategory = {};
    const playerIds = new Set();
    for (const item of issues) {
        bySeverity[item.severity] = (bySeverity[item.severity] || 0) + 1;
        byCategory[item.category] = (byCategory[item.category] || 0) + 1;
        if (item.playerId) playerIds.add(item.playerId);
    }
    return {
        playersScanned: players.length,
        playersWithIssues: playerIds.size,
        issueCount: issues.length,
        bySeverity,
        byCategory,
    };
}

async function auditPlayerDataIntegrity(db, options = {}) {
    const issues = [];
    const playerColumns = await tableColumns(db, 'jogadores');
    if (!playerColumns.size) {
        throw new Error('Tabela jogadores não encontrada.');
    }
    const players = await db.all('SELECT * FROM jogadores ORDER BY id');
    const playerMap = new Map(players.map((player) => [player.id, player]));

    let attemptsByPlayer = new Map();
    if (await tableExists(db, 'clover_trait_attempts')) {
        const attempts = await db.all('SELECT * FROM clover_trait_attempts ORDER BY player_id, attempt_number');
        attemptsByPlayer = attempts.reduce((map, row) => {
            if (!map.has(row.player_id)) map.set(row.player_id, []);
            map.get(row.player_id).push(row);
            return map;
        }, new Map());
    }

    for (const player of players) {
        if (!options.includeArchived && normalizeStatus(player.jogo_status) === 'arquivado') continue;
        auditPlayerProfile(player, issues);
        auditTraitPairs(player, attemptsByPlayer.get(player.id) || [], issues);
    }

    const templates = new Map();
    if (await tableExists(db, 'clover_item_templates')) {
        for (const template of await db.all('SELECT * FROM clover_item_templates')) {
            templates.set(template.template_key, template);
            auditText({ issues, category: 'items', code: 'template_name', field: 'item_name', entity: `template:${template.template_key}`, value: template.item_name });
            auditText({ issues, category: 'items', code: 'template_description', field: 'description', entity: `template:${template.template_key}`, value: template.description });
            for (const field of ['properties_json', 'effects_json', 'metadata_json']) {
                auditJsonField({ issues, category: 'items', code: `template_${field}_invalid`, field, entity: `template:${template.template_key}`, value: template[field] });
            }
        }
    }

    const itemRows = await tableExists(db, 'clover_inventory_items')
        ? await db.all('SELECT * FROM clover_inventory_items ORDER BY player_id, id')
        : [];
    const activeByTemplate = new Map();
    for (const item of itemRows) {
        const player = playerMap.get(item.player_id) || null;
        if (!player) {
            issues.push(issue({
                severity: 'critical', category: 'items', code: 'orphan_inventory_item',
                entity: `inventory:${item.id}`, current: item.player_id,
                detail: 'O item pertence a um player_id inexistente.',
                suggestedAction: 'Resolver a identidade do proprietário antes de mover ou excluir o item.',
            }));
        }
        const template = templates.get(item.template_key) || null;
        auditInventoryItem(item, player, template, issues);
        if (template && Number(template.duplicable) === 0 && ACTIVE_ITEM_STATUSES.has(normalizeStatus(item.status))) {
            const key = `${item.player_id}:${item.template_key}`;
            if (!activeByTemplate.has(key)) activeByTemplate.set(key, []);
            activeByTemplate.get(key).push(item);
        }
    }
    for (const rows of activeByTemplate.values()) {
        if (rows.length <= 1) continue;
        const first = rows[0];
        const player = playerMap.get(first.player_id) || null;
        issues.push(issue({
            severity: 'critical', category: 'items', code: 'nonduplicable_item_duplicated', player,
            field: 'template_key', entity: `template:${first.template_key}`,
            current: rows.map((row) => ({ id: row.id, status: row.status, quantity: row.quantity })),
            detail: 'Há mais de um exemplar ativo de um modelo marcado como não duplicável.',
            suggestedAction: 'Comparar concessões e histórico; não excluir automaticamente nenhum exemplar.',
        }));
    }

    const catalog = auditTreeCatalog(issues);
    if (await tableExists(db, 'clover_skill_nodes')) {
        const rows = await db.all('SELECT * FROM clover_skill_nodes ORDER BY player_id, tree_id, node_id');
        for (const row of rows) {
            const player = playerMap.get(row.player_id) || null;
            if (!player) {
                issues.push(issue({
                    severity: 'critical', category: 'capabilities', code: 'orphan_skill_node',
                    entity: `skill:${row.id}`, current: row.player_id,
                    detail: 'A compra de capacidade pertence a um jogador inexistente.',
                    suggestedAction: 'Resolver a identidade antes de alterar a compra.',
                }));
            }
            auditSkillNode(row, player, catalog, issues);
        }
    }
    if (await tableExists(db, 'player_skill_trees')) {
        const rows = await db.all('SELECT * FROM player_skill_trees ORDER BY player_id, tree');
        for (const row of rows) {
            auditLegacyTreeRow(row, playerMap.get(row.player_id) || null, catalog, issues);
        }
    }

    issues.sort((left, right) => {
        const weight = { critical: 0, warning: 1, review: 2 };
        return weight[left.severity] - weight[right.severity]
            || String(left.characterName || '').localeCompare(String(right.characterName || ''), 'pt-BR')
            || left.category.localeCompare(right.category);
    });

    return {
        ok: true,
        readOnly: true,
        generatedAt: new Date().toISOString(),
        database: options.databaseLabel || null,
        summary: buildSummary(issues, players.filter((player) => (
            options.includeArchived || normalizeStatus(player.jogo_status) !== 'arquivado'
        ))),
        issues,
    };
}

module.exports = {
    ACTIVE_ITEM_STATUSES,
    PLACEHOLDERS,
    auditPlayerDataIntegrity,
    auditPlayerProfile,
    auditTraitPairs,
    hasEncodingDamage,
    isPlaceholder,
    normalizeKey,
    parseJson,
    tableColumns,
    tableExists,
};
