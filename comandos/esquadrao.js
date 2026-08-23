const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { getMessageContextInfo } = require('../helpers/messageContext');
const { isOwner, isSameUser } = require('../helpers/groupAccess');
const { normalizeText } = require('../helpers/textUtils');
const {
    displayPlayerName,
    findPlayersByName,
    getPlayerById,
    getSquadByGroupId,
    getSquadByName,
    getSquadView,
    renderSquadMessage,
    syncAllSquadGroupDescriptions,
    syncSquadGroupDescription,
    updateSquadCaptainName,
    updateSquadCaptainPlayer,
    updateSquadGroup,
    updateSquadPhrase,
    updateSquadViceCaptainPlayer,
} = require('../helpers/clover/squadService');
const { resolvePlayerSquadMembership } = require('../helpers/clover/squadMembershipReadService');

async function isGroupAdmin(sock, groupId, playerId) {
    try {
        const metadata = await sock.groupMetadata(groupId);
        const participant = (metadata.participants || []).find((item) => (
            isSameUser(item.id, playerId)
            || isSameUser(item.jid, playerId)
            || isSameUser(item.lid, playerId)
        ));
        return ['admin', 'superadmin'].includes(participant?.admin);
    } catch {
        return false;
    }
}

async function canManageSquad(sock, idChat, idJogador) {
    if (isOwner(idJogador)) return true;
    if (!idChat?.endsWith('@g.us')) return false;
    return isGroupAdmin(sock, idChat, idJogador);
}

function getMentions(m) {
    return getMessageContextInfo(m)?.mentionedJid || [];
}

function getQuotedParticipant(m) {
    return getMessageContextInfo(m)?.participant || null;
}

function resolveAction(matchedCommand) {
    const command = normalizeText(matchedCommand);
    if (command.includes('setgrupoesquadrao') || command.includes('setgrupoesquadr')) return 'set_group';
    if (
        command.includes('syncesquadroes')
        || command.includes('sincronizaresquadroes')
        || command.includes('revisaresquadroes')
        || command.includes('syncgruposesquadrao')
        || command.includes('syncgruposesquadr')
    ) return 'sync_all';
    if (command.includes('syncgrupoesquadrao') || command.includes('syncesquadrao') || command.includes('sincronizaresquadrao')) return 'sync';
    if (command.includes('limparfraseesquadrao')) return 'clear_phrase';
    if (command.includes('fraseesquadrao')) return 'set_phrase';
    if (command.includes('setcapitao') || command.includes('setcapit')) return 'set_captain';
    if (command.includes('setvicecapitao') || command.includes('setvice')) return 'set_vice';
    if (command.includes('limparvicecapitao') || command.includes('limparvice')) return 'clear_vice';
    return 'show';
}

function renderSyncNotice(result) {
    if (result?.ok) return 'Descrição do grupo sincronizada.';
    if (result?.reason === 'missing_group') return 'Grupo do esquadrão ainda não foi registrado.';
    if (result?.reason === 'sync_failed') return 'Não consegui atualizar a descrição. Confirme se o bot é ADM do grupo.';
    return 'Descrição não sincronizada agora.';
}

function renderSyncAllSummary(result) {
    const detailLines = result.results.slice(0, 20).map((item) => {
        const squad = item.squad || item.sync?.squad || item.reconcile?.squad;
        const name = squad?.name || squad?.key || 'Esquadrão';
        const sync = item.sync?.ok
            ? 'descrição ok'
            : item.sync?.reason === 'missing_group'
                ? 'sem grupo'
                : `falha: ${item.sync?.error?.message || item.sync?.reason || 'erro'}`;
        const reconcile = item.reconcile?.changed
            ? `estrelas ${item.reconcile.before.currentStars}/${item.reconcile.before.historicalStars} -> ${item.reconcile.after.currentStars}/${item.reconcile.after.historicalStars}`
            : 'estrelas ok';
        return `> ${name} — ${sync}; ${reconcile}`;
    });

    if (result.results.length > detailLines.length) {
        detailLines.push(`> ... e mais ${result.results.length - detailLines.length} esquadrão(es).`);
    }

    return [
        '♧┃𝐑𝐄𝐕𝐈𝐒𝐀̃𝐎 𝐃𝐎𝐒 𝐄𝐒𝐐𝐔𝐀𝐃𝐑𝐎̃𝐄𝐒 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫',
        '     ──  grupos, estrelas e descrições sincronizados  ──',
        '',
        '_`─( ✓ )───── 𝗥𝗲𝘀𝘂𝗺𝗼`_',
        '',
        `*𝐄𝐬𝐪𝐮𝐚𝐝𝐫𝐨̃𝐞𝐬:* ${result.total}`,
        `*𝐃𝐞𝐬𝐜𝐫𝐢𝐜̧𝐨̃𝐞𝐬 𝐨𝐤:* ${result.synced}`,
        `*𝐄𝐬𝐭𝐫𝐞𝐥𝐚𝐬 𝐜𝐨𝐫𝐫𝐢𝐠𝐢𝐝𝐚𝐬:* ${result.reconciled}`,
        `*𝐒𝐞𝐦 𝐠𝐫𝐮𝐩𝐨:* ${result.missingGroup}`,
        `*𝐅𝐚𝐥𝐡𝐚𝐬:* ${result.failed}`,
        '',
        '_`─( ★ )───── 𝗗𝗲𝘁𝗮𝗹𝗵𝗲𝘀`_',
        '',
        ...detailLines,
    ].join('\n');
}

async function getCurrentGroupSquad(db, idChat) {
    if (!idChat?.endsWith('@g.us')) return null;
    return getSquadByGroupId(db, idChat);
}

async function getPlayerSquad(db, playerId) {
    const membership = await resolvePlayerSquadMembership(db, playerId);
    if (!membership.ok) return null;
    return getSquadByName(db, membership.squadKey);
}

async function resolveSquadForView(db, idChat, idJogador, body) {
    const requestedName = String(body || '').trim();
    if (requestedName) return getSquadByName(db, requestedName);

    const groupSquad = await getCurrentGroupSquad(db, idChat);
    if (groupSquad) return groupSquad;

    return getPlayerSquad(db, idJogador);
}

async function requireGroupSquad(db, idChat) {
    const squad = await getCurrentGroupSquad(db, idChat);
    return squad || null;
}

async function resolvePlayerTarget(db, m, body) {
    const mentions = getMentions(m);
    if (mentions.length === 1) {
        const player = await getPlayerById(db, mentions[0]);
        return player
            ? { ok: true, player }
            : { ok: false, error: 'A pessoa marcada não foi encontrada no banco.' };
    }
    if (mentions.length > 1) return { ok: false, error: 'Marque apenas uma pessoa.' };

    const quoted = getQuotedParticipant(m);
    if (quoted) {
        const player = await getPlayerById(db, quoted);
        if (player) return { ok: true, player };
    }

    const query = String(body || '').replace(/@\S+/g, '').trim();
    if (!query) return { ok: false, error: 'Informe ou marque um personagem.' };

    const matches = await findPlayersByName(db, query);
    if (matches.length === 1 || (matches[0] && matches[0].score >= 90 && matches[1]?.score < matches[0].score)) {
        return { ok: true, player: matches[0] };
    }
    if (matches.length > 1) {
        return {
            ok: false,
            error: `Encontrei mais de uma ficha para esse nome: ${matches.slice(0, 4).map(displayPlayerName).join(', ')}.`,
        };
    }

    return { ok: false, error: 'Não encontrei esse personagem no banco.' };
}

async function replySquadView({ sock, m, idChat, db, squad }) {
    if (!squad) {
        await sendReply({
            sock,
            idChat,
            m,
            text: 'Você ainda não está em um esquadrão registrado.',
        });
        return;
    }

    const view = await getSquadView(db, squad.key);
    await sendReply({
        sock,
        idChat,
        m,
        text: renderSquadMessage(view),
    });
}

module.exports = {
    nome: `${COMMAND_PREFIX}esquadrao`,
    aliases: [
        `${COMMAND_PREFIX}esquadrão`,
        `${COMMAND_PREFIX}setgrupoesquadrao`,
        `${COMMAND_PREFIX}setgrupoesquadrão`,
        `${COMMAND_PREFIX}syncgrupoesquadrao`,
        `${COMMAND_PREFIX}syncgrupoesquadrão`,
        `${COMMAND_PREFIX}syncesquadrao`,
        `${COMMAND_PREFIX}syncesquadrão`,
        `${COMMAND_PREFIX}syncesquadroes`,
        `${COMMAND_PREFIX}syncesquadrões`,
        `${COMMAND_PREFIX}sincronizaresquadroes`,
        `${COMMAND_PREFIX}sincronizaresquadrões`,
        `${COMMAND_PREFIX}revisaresquadroes`,
        `${COMMAND_PREFIX}revisaresquadrões`,
        `${COMMAND_PREFIX}syncgruposesquadrao`,
        `${COMMAND_PREFIX}syncgruposesquadrão`,
        `${COMMAND_PREFIX}fraseesquadrao`,
        `${COMMAND_PREFIX}fraseesquadrão`,
        `${COMMAND_PREFIX}limparfraseesquadrao`,
        `${COMMAND_PREFIX}limparfraseesquadrão`,
        `${COMMAND_PREFIX}setcapitao`,
        `${COMMAND_PREFIX}setcapitão`,
        `${COMMAND_PREFIX}setvicecapitao`,
        `${COMMAND_PREFIX}setvicecapitão`,
        `${COMMAND_PREFIX}limparvicecapitao`,
        `${COMMAND_PREFIX}limparvicecapitão`,
    ],
    descricao: 'Mostra e gerencia esquadrões Clover.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db, body, matchedCommand }) => {
        const action = resolveAction(matchedCommand);

        if (action === 'show') {
            const squad = await resolveSquadForView(db, idChat, idJogador, body);
            await replySquadView({ sock, m, idChat, db, squad });
            return;
        }

        if (action === 'sync_all') {
            if (!isOwner(idJogador)) {
                await sendReply({ sock, idChat, m, text: 'Apenas Owner pode revisar todos os grupos de esquadrão.' });
                return;
            }

            const result = await syncAllSquadGroupDescriptions({ sock, db });
            await sendReply({ sock, idChat, m, text: renderSyncAllSummary(result) });
            return;
        }

        if (!idChat?.endsWith('@g.us')) {
            await sendReply({ sock, idChat, m, text: 'Use esse comando dentro do grupo do esquadrão.' });
            return;
        }

        if (!await canManageSquad(sock, idChat, idJogador)) {
            await sendReply({ sock, idChat, m, text: 'Apenas ADM do grupo ou Owner pode gerenciar esquadrão.' });
            return;
        }

        if (action === 'set_group') {
            const squadName = String(body || '').trim();
            if (!squadName) {
                await sendReply({ sock, idChat, m, text: 'Informe o nome do esquadrão. Exemplo: *.#setgrupoesquadrao Coringas Magenta*' });
                return;
            }

            const squad = await updateSquadGroup(db, squadName, idChat);
            const sync = await syncSquadGroupDescription({ sock, db, squadKey: squad.key });
            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    `*Grupo registrado para ${squad.name}.*`,
                    '',
                    renderSyncNotice(sync),
                ].join('\n'),
            });
            return;
        }

        const squad = await requireGroupSquad(db, idChat);
        if (!squad) {
            await sendReply({ sock, idChat, m, text: 'Este grupo ainda não foi registrado como grupo de esquadrão. Use *.#setgrupoesquadrao <nome>*.' });
            return;
        }

        if (action === 'sync') {
            const sync = await syncSquadGroupDescription({ sock, db, squadKey: squad.key });
            await sendReply({ sock, idChat, m, text: renderSyncNotice(sync) });
            return;
        }

        if (action === 'set_phrase' || action === 'clear_phrase') {
            const phrase = action === 'clear_phrase' ? null : String(body || '').trim();
            if (action === 'set_phrase' && !phrase) {
                await sendReply({ sock, idChat, m, text: 'Escreva a frase do esquadrão depois do comando.' });
                return;
            }

            const updated = await updateSquadPhrase(db, squad.key, phrase);
            const sync = await syncSquadGroupDescription({ sock, db, squadKey: updated.key });
            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    action === 'clear_phrase' ? '*Frase do esquadrão removida.*' : '*Frase do esquadrão atualizada.*',
                    '',
                    renderSyncNotice(sync),
                ].join('\n'),
            });
            return;
        }

        if (action === 'set_captain') {
            const mentions = getMentions(m);
            const quoted = getQuotedParticipant(m);
            let updated = null;

            if (mentions.length || quoted) {
                const target = await resolvePlayerTarget(db, m, body);
                if (!target.ok) {
                    await sendReply({ sock, idChat, m, text: target.error });
                    return;
                }
                await db.run('UPDATE jogadores SET esquadrao = ? WHERE id = ?', [squad.name, target.player.id]);
                updated = await updateSquadCaptainPlayer(db, squad.key, target.player.id, displayPlayerName(target.player));
            } else {
                const captainName = String(body || '').trim();
                if (!captainName) {
                    await sendReply({ sock, idChat, m, text: 'Informe o nome do capitão ou marque um player.' });
                    return;
                }
                updated = await updateSquadCaptainName(db, squad.key, captainName);
            }

            const sync = await syncSquadGroupDescription({ sock, db, squadKey: updated.key });
            await sendReply({ sock, idChat, m, text: `*Capitão atualizado.*\n\n${renderSyncNotice(sync)}` });
            return;
        }

        if (action === 'set_vice') {
            const target = await resolvePlayerTarget(db, m, body);
            if (!target.ok) {
                await sendReply({ sock, idChat, m, text: target.error });
                return;
            }

            await db.run('UPDATE jogadores SET esquadrao = ? WHERE id = ?', [squad.name, target.player.id]);
            const updated = await updateSquadViceCaptainPlayer(db, squad.key, target.player.id);
            const sync = await syncSquadGroupDescription({ sock, db, squadKey: updated.key });
            await sendReply({ sock, idChat, m, text: `*Vice-capitão atualizado.*\n\n${renderSyncNotice(sync)}` });
            return;
        }

        if (action === 'clear_vice') {
            const updated = await updateSquadViceCaptainPlayer(db, squad.key, null);
            const sync = await syncSquadGroupDescription({ sock, db, squadKey: updated.key });
            await sendReply({ sock, idChat, m, text: `*Vice-capitão removido.*\n\n${renderSyncNotice(sync)}` });
        }
    },
};
