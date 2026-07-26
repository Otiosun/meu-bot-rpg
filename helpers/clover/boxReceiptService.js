'use strict';

function safeJson(value, fallback = null) {
    if (!value) return fallback;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function operationCode(openingId) {
    return `CX-${String(Number(openingId) || 0).padStart(6, '0')}`;
}

function rewardPresentation(reward = {}) {
    const type = String(reward.type || 'unknown');

    if (type === 'yulls') {
        const amount = Number(reward.amount || 0);
        return {
            type,
            name: reward.label || `${amount.toLocaleString('pt-BR')}¥`,
            quantity: amount,
            unit: 'yulls',
            destination: { key: 'wallet', label: 'Carteira', path: '/personagem/economia' },
            explanation: 'O valor foi creditado diretamente na sua Carteira.',
        };
    }

    if (type === 'ph') {
        const amount = Number(reward.amount || 0);
        return {
            type,
            name: `${amount} PH`,
            quantity: amount,
            unit: 'ph',
            destination: { key: 'progression', label: 'Progressão', path: '/personagem/evolucao' },
            explanation: reward.outsideWeeklyCap
                ? 'Os PH foram creditados fora do teto semanal.'
                : 'Os PH foram creditados na sua progressão.',
        };
    }

    if (type === 'title') {
        const compensation = Number(reward.compensationYulls || 0);
        const newlyUnlocked = reward.newlyUnlocked !== false;
        return {
            type,
            name: reward.itemName || reward.templateKey || 'Título',
            quantity: 1,
            unit: 'titulo',
            destination: newlyUnlocked
                ? { key: 'titles', label: 'Títulos', path: '/personagem/titulos' }
                : { key: 'wallet', label: 'Carteira', path: '/personagem/economia' },
            explanation: newlyUnlocked
                ? 'O Título foi desbloqueado e está disponível para ativação.'
                : `O Título já era seu e foi convertido em ${compensation.toLocaleString('pt-BR')}¥.`,
            newlyUnlocked,
            compensation: compensation > 0 ? {
                type: 'yulls',
                amount: compensation,
                label: `${compensation.toLocaleString('pt-BR')}¥`,
            } : null,
            templateKey: reward.templateKey || null,
        };
    }

    if (type === 'item' || type === 'relic') {
        return {
            type,
            name: reward.itemName || reward.templateKey || (type === 'relic' ? 'Relíquia' : 'Item'),
            quantity: Number(reward.quantity || 1),
            unit: 'item',
            destination: { key: 'inventory', label: 'Inventário', path: '/personagem/inventario' },
            explanation: type === 'relic'
                ? 'A Relíquia foi registrada e guardada no seu Inventário.'
                : 'O item foi guardado no seu Inventário.',
            templateKey: reward.templateKey || null,
            itemId: reward.itemId ? Number(reward.itemId) : null,
            expiresAt: reward.expiresAt || null,
            globallyUnique: Boolean(reward.globallyUnique),
        };
    }

    return {
        type,
        name: reward.label || 'Recompensa',
        quantity: Number(reward.quantity || reward.amount || 1),
        unit: null,
        destination: { key: 'unknown', label: 'Conta', path: null },
        explanation: 'A recompensa foi entregue e registrada.',
    };
}

function serializeBoxOpeningReceipt(row, duplicate = false) {
    if (!row) return null;
    const reward = safeJson(row.result_json, null);
    const presentedReward = rewardPresentation(reward || {});
    const completed = row.status === 'completed';

    return {
        ok: completed,
        duplicate: Boolean(duplicate),
        operation: {
            code: operationCode(row.id),
            openingId: Number(row.id),
            idempotencyKey: row.idempotency_key || null,
        },
        box: {
            key: row.box_key,
            catalogVersion: Number(row.catalog_version || 1),
        },
        status: row.status,
        rewardKey: row.reward_key,
        reward: reward || null,
        presentation: {
            headline: completed
                ? (presentedReward.newlyUnlocked === false ? 'Prêmio convertido' : 'Você ganhou')
                : 'Abertura ainda não concluída',
            reward: presentedReward,
            stored: completed,
            recoverable: true,
        },
        roll: Number(row.roll || 0),
        rollBasisPoints: Number(row.roll_basis_points || Number(row.roll || 0) * 100),
        openedAt: row.created_at || null,
        completedAt: row.completed_at || null,
    };
}

module.exports = {
    operationCode,
    rewardPresentation,
    safeJson,
    serializeBoxOpeningReceipt,
};
