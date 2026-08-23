'use strict';

// Metadata is not authorization. Integrated RBAC and canonical operation
// handlers retain all decision and mutation authority.
const OPERATION_METADATA = Object.freeze({
    'catalog.trait.update': ['Traits', 'admin.traits.manage', 'high', 'traits'],
    'catalog.trait.archive': ['Traits', 'admin.traits.manage', 'high', 'traits'],
    'catalog.trait.restore': ['Traits', 'admin.traits.manage', 'high', 'traits'],
    'player.trait.assign': ['Atribuir traco', 'admin.traits.manage', 'high', 'traits'],
    'player.trait.remove': ['Remover traco', 'admin.traits.manage', 'high', 'traits'],
    'catalog.item.create': ['Criar item', 'admin.items.manage', 'high', 'inventory'],
    'catalog.item.update': ['Atualizar item', 'admin.items.manage', 'high', 'inventory'],
    'catalog.item.archive': ['Arquivar item', 'admin.items.manage', 'high', 'inventory'],
    'catalog.item.restore': ['Restaurar item', 'admin.items.manage', 'high', 'inventory'],
    'player.item.grant': ['Conceder item', 'admin.items.manage', 'critical', 'inventory'],
    'player.trait.customize': ['Customizar traco', 'admin.traits.manage', 'high', 'traits'],
    'player.trait.reset_override': ['Limpar override', 'admin.traits.manage', 'high', 'traits'],
    'raid.progress.adjust': ['Ajustar raid', 'admin.raid.manage', 'critical', 'raid'],
    'raid.reservation.release': ['Liberar reserva', 'admin.raid.manage', 'critical', 'raid'],
});

function getAdminCentralRegistry(executors) {
    const resolvedExecutors = executors || require('./adminOperationRegistry').getAdminOperationExecutors();
    return Object.freeze(Object.keys(resolvedExecutors).sort().map((operationKey) => {
        const metadata = OPERATION_METADATA[operationKey];
        if (!metadata) throw new Error(`Admin operation lacks central metadata: ${operationKey}`);
        const [displayName, capability, risk, domain] = metadata;
        return Object.freeze({ operationKey, displayName, capability, risk, domain, input: 'handler-defined', confirmation: true, audit: true, enabled: true, handlerReference: operationKey });
    }));
}

module.exports = { OPERATION_METADATA, getAdminCentralRegistry };
