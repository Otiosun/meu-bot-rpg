const fisicoTree = require('./fisicoTree');

const TREES = {
    [fisicoTree.key]: fisicoTree,
};

function getTree(treeKey) {
    return TREES[treeKey] || null;
}

module.exports = {
    TREES,
    getTree,
};
