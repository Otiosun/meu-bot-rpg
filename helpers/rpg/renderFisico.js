const {
    normalizeText,
    canPurchaseNode,
    getEffectiveNodeCost,
    getAvailableNodes,
    getImportantLockedNodes,
    getTrackCurrentNode,
    getTrackSpentPh,
    getSectionSpentPh,
    getRouteStatus,
    getLastPurchasedNodes,
    getNextMilestoneForTrack,
    getNextNodeForBranch,
} = require('./skillTreeEngine');
const { COMMAND_PREFIX } = require('../../config/bot');

function findViewByAlias(tree, input) {
    const normalizedInput = normalizeText(input);
    if (!normalizedInput) return null;

    return Object.values(tree.views).find((view) =>
        view.aliases.some((alias) => normalizeText(alias) === normalizedInput)
    ) || null;
}

function formatCheckReason(check) {
    const lines = [];

    if (check.missing_ph > 0) lines.push(`PH insuficiente: faltam ${check.missing_ph}`);
    check.missing_requires.forEach((item) => lines.push(item));
    check.missing_any_requires.forEach((item) => lines.push(item));
    check.missing_custom_requires.forEach((item) => lines.push(item));
    check.missing_narrative.forEach((item) => lines.push(`Treinamento narrativo: ${item}`));

    return lines;
}

function formatPhysicalCost(playerState, node) {
    const base = Number(node?.cost_ph || 0);
    const effective = getEffectiveNodeCost(playerState, node);
    const discount = Number(playerState?.treeDiscount?.percent || 0);
    if (discount > 0 && effective !== base) {
        return `${effective} PH (${base} PH -${discount}%)`;
    }
    return `${effective} PH`;
}

function formatRouteStatusLine(playerState, trackKey) {
    const status = getRouteStatus(playerState, trackKey);
    const label = playerState.tree.purchaseTracks[trackKey]?.label || trackKey;

    if (status.current) {
        return `• ${label}: em progresso (${status.current.name})`;
    }

    if (status.status === 'concluído') {
        return `• ${label}: concluído`;
    }

    return `• ${label}: ${status.status}`;
}

function getUnlockHint(playerState, candidate) {
    const milestoneTrackKey = candidate.track.milestoneTrack;
    if (milestoneTrackKey) {
        const milestoneNode = getNextNodeForBranch(playerState, milestoneTrackKey);
        if (milestoneNode && milestoneNode.requires.includes(candidate.node.id)) {
            return `Falta para liberar *${milestoneNode.name}*.`;
        }
    }

    const nextNodeId = candidate.node.next_ids?.[0];
    if (nextNodeId) {
        const nextNode = playerState.tree.nodesById[nextNodeId];
        if (nextNode) return `Abre caminho para *${nextNode.name}*.`;
    }

    return candidate.node.short_effect || 'Avança seu domínio neste ramo.';
}

function getSuggestedCommandFromNode(node) {
    const branch = node?.branch;
    if (!branch) return `${COMMAND_PREFIX}fisico prox`;
    return `${COMMAND_PREFIX}fisico comprar ${branch.replace(/_/g, ' ')}`;
}

function renderFisicoSummary(playerState) {
    const vigorSpent = getSectionSpentPh(playerState, 'vigor');
    const controleSpent = getSectionSpentPh(playerState, 'controle_corporal');
    const routeLines = playerState.tree.routeStatusOrder.map((trackKey) => formatRouteStatusLine(playerState, trackKey));

    return [
        '🏋️ *Árvore Física*',
        '',
        `PH disponível: *${playerState.ph.available}*`,
        `PH gasto: *${playerState.ph.spent}*`,
        '',
        'Bases:',
        `• Vigor — ${vigorSpent} PH investidos`,
        `• Controle Corporal — ${controleSpent} PH investidos`,
        '',
        'Rotas:',
        ...routeLines,
        '',
        'Use:',
        `${COMMAND_PREFIX}fisico prox`,
        `${COMMAND_PREFIX}fisico ver vigor`,
        `${COMMAND_PREFIX}fisico ver controle`,
        `${COMMAND_PREFIX}fisico mapa`,
    ].join('\n');
}

function renderFisicoStatus(playerState) {
    const heroTracks = ['forca', 'resistencia', 'recuperacao', 'agilidade', 'velocidade', 'precisao', 'percepcao'];
    const latest = getLastPurchasedNodes(playerState, 3);
    const milestones = heroTracks
        .map((trackKey) => getNextMilestoneForTrack(playerState, trackKey))
        .filter(Boolean)
        .slice(0, 4);

    const branchLines = heroTracks.map((trackKey) => {
        const current = getTrackCurrentNode(playerState, trackKey);
        const label = playerState.tree.purchaseTracks[trackKey]?.label || trackKey;
        return `• ${label} — ${current ? current.name : 'sem investimento'}`;
    });

    return [
        '🏋️ *Status físico*',
        '',
        `PH disponível: *${playerState.ph.available}*`,
        `PH gasto: *${playerState.ph.spent}*`,
        '',
        'Principais ramos:',
        ...branchLines,
        '',
        'Últimas compras:',
        ...(latest.length > 0 ? latest.map((node) => `• ${node.name}`) : ['• Nenhuma ainda']),
        '',
        'Próximos marcos:',
        ...(milestones.length > 0 ? milestones.map((node) => `• ${node.name}`) : ['• Nada pendente por enquanto']),
        ...(playerState.narrativeFlags.length > 0
            ? ['', `Flags narrativas: ${playerState.narrativeFlags.join(', ')}`]
            : []),
    ].join('\n');
}

function renderFisicoProx(playerState) {
    const available = getAvailableNodes(playerState).slice(0, 6);
    const locked = getImportantLockedNodes(playerState)
        .filter((candidate) => candidate.node.type !== 'atributo' || candidate.check.missing_requires.length <= 2)
        .slice(0, 4);

    const lines = [
        '🏋️ *Próximas habilidades físicas*',
        '',
        `PH disponível: *${playerState.ph.available}*`,
        '',
    ];

    if (available.length === 0) {
        lines.push('Nenhuma compra disponível agora.');
    } else {
        available.forEach((candidate, index) => {
            lines.push(`${index + 1}. *${candidate.node.name}* — ${formatPhysicalCost(playerState, candidate.node)}`);
            lines.push(`   ${getUnlockHint(playerState, candidate)}`);
            lines.push('');
        });
        if (lines[lines.length - 1] === '') lines.pop();
    }

    if (locked.length > 0) {
        lines.push('', 'Bloqueados próximos:');
        locked.forEach((candidate) => {
            const reasons = formatCheckReason(candidate.check).slice(0, 2);
            lines.push(`🔒 *${candidate.node.name}*`);
            lines.push(`Requer: ${reasons.join(' • ')}`);
            lines.push('');
        });
        if (lines[lines.length - 1] === '') lines.pop();
    }

    lines.push('', 'Use:', `${COMMAND_PREFIX}fisico comprar 1`, `${COMMAND_PREFIX}fisico ver agilidade`);

    return {
        text: lines.join('\n'),
        optionIds: available.map((candidate) => candidate.node.id),
    };
}

function formatTrackLine(playerState, trackKey) {
    const track = playerState.tree.purchaseTracks[trackKey];
    if (!track) return null;

    const current = getTrackCurrentNode(playerState, trackKey);
    const next = getNextNodeForBranch(playerState, trackKey);
    const invested = getTrackSpentPh(playerState, trackKey);

    if (current && next) {
        return `• ${track.label}: ${current.name} (${invested} PH) -> próximo ${next.name}`;
    }

    if (current) {
        return `• ${track.label}: ${current.name} (${invested} PH)`;
    }

    if (next) {
        return `• ${track.label}: sem investimento -> próximo ${next.name}`;
    }

    return `• ${track.label}: concluído`;
}

function renderBranchView(playerState, branchInput) {
    const view = findViewByAlias(playerState.tree, branchInput);
    if (!view) {
        return {
            ok: false,
            text: '⚠️ Ramo não encontrado. Tente: vigor, controle, forca, resistencia, recuperacao, agilidade, velocidade, precisao, percepcao, sentidos, barbaro, culto, ki.',
        };
    }

    const candidates = view.tracks
        .map((trackKey) => {
            const next = getNextNodeForBranch(playerState, trackKey);
            if (!next) return null;
            return {
                track: playerState.tree.purchaseTracks[trackKey],
                node: next,
                check: canPurchaseNode(playerState, next),
            };
        })
        .filter(Boolean);

    const available = candidates.filter((candidate) => candidate.check.ok).slice(0, 3);
    const locked = candidates.filter((candidate) => !candidate.check.ok).slice(0, 3);
    const milestoneTracks = view.heroTracks.length > 0 ? view.heroTracks : view.tracks;
    const milestones = milestoneTracks
        .map((trackKey) => getNextMilestoneForTrack(playerState, trackKey))
        .filter(Boolean)
        .slice(0, 3);

    const progressTracks = view.heroTracks.length > 1 ? view.heroTracks : view.tracks;
    const supportTracks = view.tracks.filter((trackKey) => !progressTracks.includes(trackKey));
    const mapCommandTarget = view.key.replace(/_/g, ' ');

    const lines = [
        `🏋️ *${view.label}*`,
        '',
        `PH disponível: *${playerState.ph.available}*`,
        view.description,
        '',
        'Progresso atual:',
        ...progressTracks.map((trackKey) => formatTrackLine(playerState, trackKey)).filter(Boolean),
    ];

    if (supportTracks.length > 0) {
        const supportLabels = supportTracks
            .map((trackKey) => playerState.tree.purchaseTracks[trackKey]?.label)
            .filter(Boolean)
            .slice(0, 6);
        lines.push('', `Apoios deste ramo: ${supportLabels.join(', ')}.`);
    }

    if (available.length > 0) {
        lines.push('', 'Próximas compras:');
        available.forEach((candidate) => {
            lines.push(`• ${candidate.node.name} — ${formatPhysicalCost(playerState, candidate.node)}`);
        });
    }

    if (locked.length > 0) {
        lines.push('', 'Bloqueios relevantes:');
        locked.forEach((candidate) => {
            const reasons = formatCheckReason(candidate.check).slice(0, 2).join(' • ');
            lines.push(`• ${candidate.node.name} — falta ${reasons}`);
        });
    }

    if (milestones.length > 0) {
        lines.push('', 'Marcos à frente:');
        milestones.forEach((node) => lines.push(`• ${node.name}`));
    }

    lines.push('', 'Use:', `${COMMAND_PREFIX}fisico comprar ${view.heroTracks[0] || view.tracks[0]}`, `${COMMAND_PREFIX}fisico mapa ${mapCommandTarget}`);

    return {
        ok: true,
        view,
        text: lines.join('\n'),
    };
}

function renderPurchaseBlocked(playerState, node, check) {
    const missingLines = [];

    if (check.missing_ph > 0) {
        missingLines.push(`• PH insuficiente: faltam ${check.missing_ph}`);
    }
    check.missing_requires.forEach((item) => missingLines.push(`• ${item}`));
    check.missing_any_requires.forEach((item) => missingLines.push(`• ${item}`));
    check.missing_custom_requires.forEach((item) => missingLines.push(`• ${item}`));
    check.missing_narrative.forEach((item) => missingLines.push(`• Treinamento narrativo: ${item}`));

    const ownedLines = check.satisfied_requires.slice(0, 4).map((item) => `• ${item}`);

    return [
        `🔒 *${node?.name || 'Habilidade'} bloqueado*`,
        '',
        'Falta:',
        ...(missingLines.length > 0 ? missingLines : ['• Nenhum requisito pendente identificado']),
        ...(ownedLines.length > 0 ? ['', 'Você já tem:', ...ownedLines] : []),
        '',
        `PH disponível: *${playerState.ph.available}*`,
    ].join('\n');
}

function renderPurchaseSuccess(result) {
    const { node, stateAfter, newlyAvailable } = result;
    const interestingUnlocks = newlyAvailable
        .filter((item) => item.node.type !== 'atributo')
        .slice(0, 2);
    const fallbackNext = getNextNodeForBranch(stateAfter, node.branch);

    const lines = [
        `✅ *${node.name}* entrou na sua árvore!`,
        '',
        node.description,
    ];

    if (interestingUnlocks.length > 0) {
        lines.push('', '🔥 Novo desbloqueio:');
        interestingUnlocks.forEach((item) => lines.push(`• *${item.node.name}* agora pode ser comprado.`));
    } else if (fallbackNext) {
        lines.push('', `Próximo passo natural: *${fallbackNext.name}*.`);
    }

    lines.push('', `PH gasto: ${formatPhysicalCost(result.stateBefore, node)}`, `PH restante: ${stateAfter.ph.available}`);

    const suggestedNode = interestingUnlocks[0]?.node || fallbackNext;
    if (suggestedNode) {
        lines.push('', 'Use:', getSuggestedCommandFromNode(suggestedNode));
    }

    return lines.join('\n');
}

module.exports = {
    findViewByAlias,
    renderFisicoSummary,
    renderFisicoStatus,
    renderFisicoProx,
    renderBranchView,
    renderPurchaseBlocked,
    renderPurchaseSuccess,
};
