const fs = require('fs');
const path = require('path');

const { normalizeText } = require('../textUtils');

const TREES_DIR = path.join(process.cwd(), 'data', 'clover', 'trees');

let cachedTrees = null;

function normalizeKey(value) {
    return normalizeText(value)
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function requireArray(value, label) {
    if (!Array.isArray(value)) {
        throw new Error(`Arvore invalida: ${label} precisa ser array.`);
    }
}

function requireOptionalArray(value, label) {
    if (value === undefined || value === null) return;
    requireArray(value, label);
}

function validateTree(tree, filePath) {
    if (!tree || typeof tree !== 'object') {
        throw new Error(`Arvore invalida em ${filePath}.`);
    }

    for (const field of ['id', 'name', 'routes', 'nodes', 'edges', 'goals']) {
        if (tree[field] === undefined || tree[field] === null) {
            throw new Error(`Arvore ${filePath} sem campo obrigatorio: ${field}.`);
        }
    }

    requireArray(tree.routes, 'routes');
    requireArray(tree.nodes, 'nodes');
    requireArray(tree.edges, 'edges');
    requireArray(tree.goals, 'goals');

    const routeIds = new Set();
    for (const route of tree.routes) {
        for (const field of ['id', 'name', 'symbol', 'shortDescription', 'leadsTo']) {
            if (route[field] === undefined || route[field] === null) {
                throw new Error(`Rota invalida em ${tree.id}: ${route.id || '?'} sem ${field}.`);
            }
        }
        requireArray(route.leadsTo, `route.${route.id}.leadsTo`);
        if (routeIds.has(route.id)) throw new Error(`Rota duplicada em ${tree.id}: ${route.id}.`);
        routeIds.add(route.id);
    }

    const nodeIds = new Set();
    for (const node of tree.nodes) {
        for (const field of ['id', 'name', 'route', 'tier', 'cost', 'shortEffect', 'effect', 'requires', 'unlocks', 'requiresApproval', 'tags']) {
            if (node[field] === undefined || node[field] === null) {
                throw new Error(`No invalido em ${tree.id}: ${node.id || '?'} sem ${field}.`);
            }
        }
        requireArray(node.requires, `node.${node.id}.requires`);
        requireOptionalArray(node.requiresAny, `node.${node.id}.requiresAny`);
        if (Array.isArray(node.requiresAny)) {
            node.requiresAny.forEach((group, index) => {
                requireArray(group, `node.${node.id}.requiresAny.${index}`);
            });
        }
        requireArray(node.unlocks, `node.${node.id}.unlocks`);
        requireArray(node.tags, `node.${node.id}.tags`);
        if (!routeIds.has(node.route)) throw new Error(`No ${node.id} aponta rota inexistente: ${node.route}.`);
        if (nodeIds.has(node.id)) throw new Error(`No duplicado em ${tree.id}: ${node.id}.`);
        if (!Number.isInteger(Number(node.cost)) || Number(node.cost) < 0) {
            throw new Error(`No ${node.id} tem custo invalido.`);
        }
        nodeIds.add(node.id);
    }

    for (const node of tree.nodes) {
        for (const requiredId of node.requires) {
            if (!nodeIds.has(requiredId)) {
                throw new Error(`No ${node.id} requer no inexistente: ${requiredId}.`);
            }
        }
        for (const group of node.requiresAny || []) {
            if (!group.length) {
                throw new Error(`No ${node.id} possui grupo requiresAny vazio.`);
            }
            for (const requiredId of group) {
                if (!nodeIds.has(requiredId)) {
                    throw new Error(`No ${node.id} requer alternativa inexistente: ${requiredId}.`);
                }
            }
        }
        for (const unlockedId of node.unlocks) {
            if (!nodeIds.has(unlockedId)) {
                throw new Error(`No ${node.id} desbloqueia no inexistente: ${unlockedId}.`);
            }
        }
    }

    for (const edge of tree.edges) {
        if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
            throw new Error(`Aresta invalida em ${tree.id}: ${edge.from} -> ${edge.to}.`);
        }
    }

    for (const goal of tree.goals) {
        for (const field of ['id', 'name', 'description', 'requires']) {
            if (goal[field] === undefined || goal[field] === null) {
                throw new Error(`Objetivo invalido em ${tree.id}: ${goal.id || '?'} sem ${field}.`);
            }
        }
        requireArray(goal.requires, `goal.${goal.id}.requires`);
        for (const requiredId of goal.requires) {
            if (!nodeIds.has(requiredId)) {
                throw new Error(`Objetivo ${goal.id} requer no inexistente: ${requiredId}.`);
            }
        }
    }
}

function hydrateTree(tree, filePath) {
    validateTree(tree, filePath);

    const routesById = Object.fromEntries(tree.routes.map((route) => [route.id, route]));
    const nodesById = Object.fromEntries(tree.nodes.map((node) => [node.id, node]));
    const aliases = [
        tree.id,
        tree.name,
        ...(tree.aliases || []),
    ].map(normalizeKey).filter(Boolean);

    return {
        ...tree,
        aliases,
        routesById,
        nodesById,
    };
}

function loadTrees(options = {}) {
    if (cachedTrees && !options.forceReload) return cachedTrees;

    if (!fs.existsSync(TREES_DIR)) {
        cachedTrees = [];
        return cachedTrees;
    }

    cachedTrees = fs.readdirSync(TREES_DIR)
        .filter((file) => file.endsWith('.json'))
        .sort()
        .map((file) => {
            const filePath = path.join(TREES_DIR, file);
            return hydrateTree(JSON.parse(fs.readFileSync(filePath, 'utf8')), filePath);
        });

    return cachedTrees;
}

function getTree(treeIdOrAlias = 'mana') {
    const normalized = normalizeKey(treeIdOrAlias || 'mana');
    return loadTrees().find((tree) => tree.aliases.includes(normalized)) || null;
}

function listTrees() {
    return loadTrees();
}

module.exports = {
    getTree,
    listTrees,
    loadTrees,
    normalizeKey,
};
