'use strict';

const TREES_MAINTENANCE_MODE = true;
const TREES_MAINTENANCE_MESSAGE = [
    'Árvores estão temporariamente em revisão.',
    'Capacidades já adquiridas continuam válidas.',
    'Novas compras/evoluções estão pausadas por enquanto.',
].join('\n');

function getTreeMutationBlock(options = {}) {
    const maintenanceMode = options.maintenanceMode ?? TREES_MAINTENANCE_MODE;
    if (!maintenanceMode) return null;
    return {
        ok: false,
        reason: 'trees_maintenance',
        message: TREES_MAINTENANCE_MESSAGE,
    };
}

module.exports = {
    TREES_MAINTENANCE_MESSAGE,
    TREES_MAINTENANCE_MODE,
    getTreeMutationBlock,
};
