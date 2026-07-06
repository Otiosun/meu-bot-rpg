const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { isSameUser } = require('../helpers/groupAccess');
const { normalizeText } = require('../helpers/textUtils');
const {
    canManagePlayer,
    formatMention,
    getPlayerById,
    getQuotedParticipant,
    playerDisplayName,
    resolveTargetAndRest,
    resolveTargetPlayer,
} = require('../helpers/clover/commandTargetUtils');
const {
    findSpell,
    parseSpellSheet,
    removeSpell,
    renderSpellCard,
    renderSpellSheetTemplate,
    renderSpellUsage,
    saveSpell,
} = require('../helpers/clover/spellbookService');

function splitAction(body) {
    const text = String(body || '').trim();
    const match = text.match(/^(\S+)(?:\s+([\s\S]*))?$/);
    const action = normalizeText(match?.[1] || '').replace(/[^a-z0-9]+/g, '');
    return {
        action,
        rest: String(match?.[2] || '').trim(),
    };
}

function normalizeAction(action) {
    if (['adicionar', 'add', 'aprovar', 'novo', 'salvar'].includes(action)) return 'add';
    if (['atualizar', 'update', 'upar', 'evoluir', 'versao'].includes(action)) return 'update';
    if (['remover', 'apagar', 'excluir', 'tirar'].includes(action)) return 'remove';
    if (['ajuda', 'help'].includes(action)) return 'help';
    return null;
}

function inferActionFromCommand(command) {
    const compact = normalizeText(command || '').replace(/[^a-z0-9]+/g, '');
    if (['addfeitico', 'addfeitico', 'adicionarfeitico', 'adicionarfeitico'].includes(compact)) return 'add';
    if (['atualizarfeitico', 'atualizarfeitico', 'upfeitico', 'upfeitico'].includes(compact)) return 'update';
    if (['removerfeitico', 'removerfeitico', 'apagarfeitico', 'apagarfeitico'].includes(compact)) return 'remove';
    return null;
}

async function resolveAdminTarget(db, text, m) {
    const { targetId, targetText, rest } = resolveTargetAndRest(text, m);
    if (!targetId && !targetText) {
        return {
            ok: false,
            error: 'Marque o player, informe o número/nome, ou responda uma mensagem dele.',
        };
    }

    const resolved = await resolveTargetPlayer(db, targetId, targetText, { mechanical: true });
    if (resolved.ok) return { ok: true, player: resolved.player, rest };
    return resolved;
}

function renderSheetErrors(parsed) {
    return [
        'A ficha do feitiço está incompleta.',
        '',
        `*Falta revisar:* ${parsed.errors.join(', ')}`,
        '',
        renderSpellSheetTemplate(),
    ].join('\n');
}

function renderSaveProblem(result, sheet) {
    if (result.code === 'already_exists') {
        return [
            `Esse feitiço já existe como *v${result.latestVersion}*.`,
            '',
            `Use *${COMMAND_PREFIX}feitico atualizar @player* com a ficha nova para criar a próxima versão.`,
        ].join('\n');
    }
    if (result.code === 'version_exists') {
        return [
            `Já existe uma versão com esse número para *${sheet.name}*.`,
            '',
            `Última versão salva: *v${result.latestVersion}*.`,
        ].join('\n');
    }
    return 'Não consegui salvar esse feitiço agora.';
}

async function handleSaveSpell({ sock, m, idChat, idJogador, db, rest, update }) {
    if (!await canManagePlayer(sock, idChat, idJogador)) {
        await sendReply({ sock, idChat, m, text: 'Apenas ADM do grupo ou Owner pode adicionar feitiço no bot.' });
        return;
    }

    const target = await resolveAdminTarget(db, rest, m);
    if (!target.ok) {
        await sendReply({ sock, idChat, m, text: target.error });
        return;
    }

    if (!target.rest) {
        await sendReply({
            sock,
            idChat,
            m,
            text: [
                'Mande a ficha do feitiço na mesma mensagem do comando.',
                '',
                `Exemplo: *${COMMAND_PREFIX}feitico ${update ? 'atualizar' : 'adicionar'} @player*`,
                '',
                renderSpellSheetTemplate(),
            ].join('\n'),
        });
        return;
    }

    const parsed = parseSpellSheet(target.rest);
    if (!parsed.ok) {
        await sendReply({ sock, idChat, m, text: renderSheetErrors(parsed) });
        return;
    }

    const result = await saveSpell(db, target.player.id, parsed.sheet, idJogador, { nextVersion: update });
    if (!result.ok) {
        await sendReply({ sock, idChat, m, text: renderSaveProblem(result, parsed.sheet) });
        return;
    }

    const player = await getPlayerById(db, target.player.id);
    await sendReply({
        sock,
        idChat,
        m,
        mentions: [target.player.id],
        text: [
            result.mode === 'updated'
                ? '♧┃FEITIÇO ATUALIZADO 𖥔 CLOVER MULTICOLOR'
                : '♧┃FEITIÇO ADICIONADO 𖥔 CLOVER MULTICOLOR',
            '',
            `*Player:* ${playerDisplayName(player, target.player.id)} (${formatMention(target.player.id)})`,
            '',
            renderSpellCard(result.spell, result.mode === 'updated' ? 'NOVA VERSÃO DE FEITIÇO' : 'FEITIÇO APROVADO'),
        ].join('\n'),
    });
}

async function handleRemoveSpell({ sock, m, idChat, idJogador, db, rest }) {
    if (!await canManagePlayer(sock, idChat, idJogador)) {
        await sendReply({ sock, idChat, m, text: 'Apenas ADM do grupo ou Owner pode remover feitiço do bot.' });
        return;
    }

    const target = await resolveAdminTarget(db, rest, m);
    if (!target.ok) {
        await sendReply({ sock, idChat, m, text: target.error });
        return;
    }
    if (!target.rest) {
        await sendReply({
            sock,
            idChat,
            m,
            text: `Informe o nome do feitiço. Exemplo: *${COMMAND_PREFIX}feitico remover @player Mão de Lama*`,
        });
        return;
    }

    const result = await removeSpell(db, target.player.id, target.rest, idJogador);
    if (!result.ok) {
        const text = result.code === 'ambiguous'
            ? `Encontrei mais de um feitiço parecido: ${result.matches.map((spell) => spell.name).join(', ')}.`
            : 'Feitiço não encontrado no grimório desse player.';
        await sendReply({ sock, idChat, m, text });
        return;
    }

    await sendReply({
        sock,
        idChat,
        m,
        mentions: [target.player.id],
        text: [
            '♧┃FEITIÇO REMOVIDO 𖥔 CLOVER MULTICOLOR',
            '',
            `*Player:* ${formatMention(target.player.id)}`,
            `*Feitiço:* ${result.spell.name} v${result.spell.version}`,
        ].join('\n'),
    });
}

async function resolveViewTarget({ db, body, m, idJogador }) {
    const quoted = getQuotedParticipant(m);
    const hasMention = (m?.message?.extendedTextMessage?.contextInfo?.mentionedJid || []).length > 0;
    if (!quoted && !hasMention) {
        const player = await getPlayerById(db, idJogador);
        return { ok: true, player: player || { id: idJogador }, query: String(body || '').trim() };
    }

    const { targetId, targetText, rest } = resolveTargetAndRest(body, m);
    const resolved = await resolveTargetPlayer(db, targetId, targetText);
    if (!resolved.ok) return resolved;
    return { ok: true, player: resolved.player, query: rest };
}

module.exports = {
    nome: `${COMMAND_PREFIX}feitico`,
    aliases: [
        `${COMMAND_PREFIX}feitiço`,
        `${COMMAND_PREFIX}spell`,
        `${COMMAND_PREFIX}addfeitico`,
        `${COMMAND_PREFIX}addfeitiço`,
        `${COMMAND_PREFIX}adicionarfeitico`,
        `${COMMAND_PREFIX}adicionarfeitiço`,
        `${COMMAND_PREFIX}atualizarfeitico`,
        `${COMMAND_PREFIX}atualizarfeitiço`,
        `${COMMAND_PREFIX}upfeitico`,
        `${COMMAND_PREFIX}upfeitiço`,
        `${COMMAND_PREFIX}removerfeitico`,
        `${COMMAND_PREFIX}removerfeitiço`,
    ],
    descricao: 'Mostra, adiciona, atualiza ou remove feitiços aprovados.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db, body, matchedCommand }) => {
        const { action: rawAction, rest } = splitAction(body);
        const aliasAction = inferActionFromCommand(matchedCommand);
        const action = aliasAction || normalizeAction(rawAction);
        const actionRest = aliasAction ? String(body || '').trim() : rest;

        if (action === 'help' || (!body && !action)) {
            await sendReply({ sock, idChat, m, text: renderSpellUsage(COMMAND_PREFIX) });
            return;
        }

        if (action === 'add' || action === 'update') {
            await handleSaveSpell({ sock, m, idChat, idJogador, db, rest: actionRest, update: action === 'update' });
            return;
        }

        if (action === 'remove') {
            await handleRemoveSpell({ sock, m, idChat, idJogador, db, rest: actionRest });
            return;
        }

        const target = await resolveViewTarget({ db, body, m, idJogador });
        if (!target.ok) {
            await sendReply({ sock, idChat, m, text: target.error });
            return;
        }
        if (!target.query) {
            await sendReply({ sock, idChat, m, text: renderSpellUsage(COMMAND_PREFIX) });
            return;
        }

        const ownView = isSameUser(target.player.id, idJogador);
        if (!ownView && !await canManagePlayer(sock, idChat, idJogador)) {
            await sendReply({
                sock,
                idChat,
                m,
                text: 'Apenas ADM do grupo ou Owner pode ver feitiço de outro player.',
            });
            return;
        }

        const result = await findSpell(db, target.player.id, target.query);
        if (!result.ok) {
            const text = result.code === 'ambiguous'
                ? `Encontrei mais de um feitiço parecido: ${result.matches.map((spell) => spell.name).join(', ')}.`
                : 'Feitiço não encontrado no grimório.';
            await sendReply({ sock, idChat, m, text });
            return;
        }

        await sendReply({
            sock,
            idChat,
            m,
            mentions: [target.player.id],
            text: renderSpellCard(result.spell),
        });
    },
};
