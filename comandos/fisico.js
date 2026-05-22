const fisicoTree = require('../helpers/rpg/arvores/fisicoTree');
const { COMMAND_PREFIX } = require('../config/bot');
const {
    getPlayerSkillState,
    getNodeByAlias,
    canPurchaseNode,
    purchaseNode,
    updateLastProxOptions,
} = require('../helpers/rpg/skillTreeEngine');
const {
    findViewByAlias,
    renderFisicoSummary,
    renderFisicoStatus,
    renderFisicoProx,
    renderBranchView,
    renderPurchaseBlocked,
    renderPurchaseSuccess,
} = require('../helpers/rpg/renderFisico');
const { sendTreeMap } = require('../helpers/rpg/treeImages');

function normalizeArgument(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

function renderHelp() {
    return [
        '🏋️ *Comandos da Árvore Física*',
        '',
        `${COMMAND_PREFIX}fisico`,
        `${COMMAND_PREFIX}fisico status`,
        `${COMMAND_PREFIX}fisico prox`,
        `${COMMAND_PREFIX}fisico ver <ramo>`,
        `${COMMAND_PREFIX}fisico comprar <habilidade ou número>`,
        `${COMMAND_PREFIX}fisico mapa [ramo]`,
    ].join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}fisico`,
    descricao: 'Mostra, compra e acompanha a Árvore Física de habilidades.',
    executar: async ({ sock, idChat, idJogador, args, db }) => {
        const playerState = await getPlayerSkillState(db, idJogador, 'fisico');
        if (!playerState) {
            return sock.sendMessage(idChat, { text: `❌ Você precisa se registrar primeiro com ${COMMAND_PREFIX}registrar.` });
        }

        const subcommand = normalizeArgument(args[1] || '');
        const tail = args.slice(2).join(' ').trim();

        if (!subcommand) {
            return sock.sendMessage(idChat, { text: renderFisicoSummary(playerState) });
        }

        if (subcommand === 'status') {
            return sock.sendMessage(idChat, { text: renderFisicoStatus(playerState) });
        }

        if (subcommand === 'prox') {
            const rendered = renderFisicoProx(playerState);
            await updateLastProxOptions(db, idJogador, 'fisico', rendered.optionIds);
            return sock.sendMessage(idChat, { text: rendered.text });
        }

        if (subcommand === 'ver') {
            if (!tail) {
                return sock.sendMessage(idChat, { text: `⚠️ Escolha um ramo. Exemplo: ${COMMAND_PREFIX}fisico ver agilidade` });
            }

            const rendered = renderBranchView(playerState, tail);
            return sock.sendMessage(idChat, { text: rendered.text });
        }

        if (subcommand === 'comprar') {
            if (!tail) {
                return sock.sendMessage(idChat, { text: `⚠️ Diga o que comprar. Exemplo: ${COMMAND_PREFIX}fisico comprar forca ou ${COMMAND_PREFIX}fisico comprar 1` });
            }

            let targetNode = null;
            if (/^\d+$/.test(tail)) {
                const optionIndex = Number(tail) - 1;
                const nodeId = playerState.lastProxOptions[optionIndex];
                if (!nodeId) {
                    return sock.sendMessage(idChat, { text: `⚠️ Essa opção não existe. Rode ${COMMAND_PREFIX}fisico prox primeiro.` });
                }
                targetNode = playerState.tree.nodesById[nodeId];
            } else {
                targetNode = getNodeByAlias(tail, fisicoTree, playerState);
            }

            if (!targetNode) {
                return sock.sendMessage(idChat, { text: `⚠️ Não encontrei essa habilidade. Tente algo como ${COMMAND_PREFIX}fisico comprar forca, fluxo, impacto ou ki.` });
            }

            const validation = canPurchaseNode(playerState, targetNode);
            if (!validation.ok) {
                if (validation.already_unlocked) {
                    return sock.sendMessage(idChat, { text: `✅ Você já possui *${targetNode.name}*.` });
                }
                return sock.sendMessage(idChat, { text: renderPurchaseBlocked(playerState, targetNode, validation) });
            }

            const result = await purchaseNode(db, idJogador, 'fisico', targetNode.id);
            if (!result.ok) {
                return sock.sendMessage(idChat, { text: renderPurchaseBlocked(playerState, targetNode, result.reason) });
            }

            await sock.sendMessage(idChat, { text: renderPurchaseSuccess(result) });
            await sendTreeMap({
                sock,
                idChat,
                tree: fisicoTree,
                regionKey: result.node.image_region || 'completo',
                caption: `${fisicoTree.icon} ${result.node.name}`,
                silentFallback: true,
            });
            return;
        }

        if (subcommand === 'mapa') {
            if (!tail) {
                await sendTreeMap({
                    sock,
                    idChat,
                    tree: fisicoTree,
                    regionKey: 'completo',
                });
                return;
            }

            const view = findViewByAlias(fisicoTree, tail);
            if (!view) {
                return sock.sendMessage(idChat, { text: '⚠️ Região não encontrada. Tente: vigor, controle, forca, resistencia, recuperacao, agilidade, velocidade, precisao, percepcao, sentidos, barbaro, culto ou ki.' });
            }

            await sendTreeMap({
                sock,
                idChat,
                tree: fisicoTree,
                regionKey: view.imageRegion || view.key,
                caption: `${fisicoTree.icon} ${fisicoTree.label} — ${view.label}`,
            });
            return;
        }

        return sock.sendMessage(idChat, { text: renderHelp() });
    },
};
