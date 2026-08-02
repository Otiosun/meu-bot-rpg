'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const FILES = Object.freeze({
    policy: {
        path: 'helpers/clover/privateMessagePolicy.js',
        sha: 'e57c0b6b5c5deac0562259e3de6b78473e93f980',
    },
    registration: {
        path: 'helpers/clover/registrationManager.js',
        sha: '63da5d59e0eb8e56bb946e089ed1a7aca3631052',
    },
    appearance: {
        path: 'helpers/clover/appearanceManager.js',
        sha: '717e7a56f5ea11d4c3931fd5b5be51640635acb3',
    },
    history: {
        path: 'comandos/historiaJogo.js',
        sha: 'c0a90c21451c193cf43d64c6ecf32b814f39726b',
    },
    groups: {
        path: 'helpers/clover/groupManager.js',
        sha: '6567f32425c56ad6b4e813af482dd3b288c26ff9',
    },
    exit: {
        path: 'helpers/clover/communityExitManager.js',
        sha: '70e3a8ad485413db785b86decb853e7ac3ed1613',
    },
});

function normalizeLf(content) {
    return String(content || '').replace(/\r\n/g, '\n');
}

function restoreEol(content, eol) {
    const normalized = normalizeLf(content);
    return eol === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized;
}

function gitBlobSha(content) {
    const body = Buffer.from(content, 'utf8');
    const header = Buffer.from(`blob ${body.length}\0`, 'utf8');
    return crypto.createHash('sha1').update(header).update(body).digest('hex');
}

function countOccurrences(content, needle) {
    if (!needle) return 0;
    let count = 0;
    let cursor = 0;
    while (true) {
        const index = content.indexOf(needle, cursor);
        if (index < 0) return count;
        count += 1;
        cursor = index + needle.length;
    }
}

function replaceExactly(content, before, after, label) {
    if (content.includes(after) && !content.includes(before)) return content;
    const count = countOccurrences(content, before);
    if (count !== 1) {
        throw new Error(`${label}: esperado 1 trecho original, encontrado ${count}.`);
    }
    return content.replace(before, after);
}

function patchPolicy(content) {
    let next = content;
    next = replaceExactly(
        next,
        "    game_release: {\n        category: POLICY_CATEGORIES.TRANSACTIONAL,\n        disposition: 'preserve',\n        label: 'Liberação do jogo',\n    },\n",
        "    game_release: {\n        category: POLICY_CATEGORIES.TRANSACTIONAL,\n        disposition: 'preserve',\n        label: 'Liberação do jogo',\n    },\n    game_block: {\n        category: POLICY_CATEGORIES.TRANSACTIONAL,\n        disposition: 'preserve',\n        label: 'Bloqueio de acesso ao jogo',\n    },\n",
        'policy.game_block'
    );
    next = replaceExactly(
        next,
        "    spell_review_invite: {\n        category: POLICY_CATEGORIES.TRANSACTIONAL,\n        disposition: 'preserve',\n        label: 'Convite do grupo de avaliação',\n    },\n",
        "    spell_review_invite: {\n        category: POLICY_CATEGORIES.TRANSACTIONAL,\n        disposition: 'preserve',\n        label: 'Convite do grupo de avaliação',\n    },\n    spell_review_invite_fallback: {\n        category: POLICY_CATEGORIES.TRANSACTIONAL,\n        disposition: 'preserve',\n        label: 'Fallback do convite de avaliação',\n    },\n",
        'policy.spell_review_invite_fallback'
    );
    next = replaceExactly(
        next,
        "    community_exit_confirmation: {\n        category: POLICY_CATEGORIES.TRANSACTIONAL,\n        disposition: 'preserve',\n        label: 'Confirmação de saída/retorno',\n    },\n",
        "    community_exit_confirmation: {\n        category: POLICY_CATEGORIES.TRANSACTIONAL,\n        disposition: 'preserve',\n        label: 'Confirmação de saída/retorno',\n    },\n    community_exit_reply: {\n        category: POLICY_CATEGORIES.REACTIVE,\n        disposition: 'preserve',\n        label: 'Resposta ao fluxo de saída/retorno',\n    },\n",
        'policy.community_exit_reply'
    );
    return next;
}

function patchRegistration(content) {
    return replaceExactly(
        content,
        "        await sendPrivateText({\n            sock,\n            playerId,\n            text: renderPostFichaPrivateInstructions({ offGroupLink }),\n        });",
        "        await sendPrivateText({\n            sock,\n            playerId,\n            text: renderPostFichaPrivateInstructions({ offGroupLink }),\n            policy: {\n                source: 'post_ficha',\n                dedupeKey: `post_ficha:${playerId}`,\n            },\n        });",
        'registration.post_ficha'
    );
}

function patchAppearance(content) {
    let next = content;
    next = replaceExactly(
        next,
        "async function notifyPlayerAppearanceResult(sock, fallbackGroupId, playerId, text, mentions = []) {\n    try {\n        await sendPrivateText({ sock, playerId, text });",
        "async function notifyPlayerAppearanceResult(sock, fallbackGroupId, playerId, text, mentions = [], policy = {}) {\n    try {\n        await sendPrivateText({ sock, playerId, text, policy });",
        'appearance.notification_helper'
    );
    next = replaceExactly(
        next,
        "    await notifyPlayerAppearanceResult(sock, idChat, review.player_id, playerText, [reviewerId]);",
        "    await notifyPlayerAppearanceResult(\n        sock,\n        idChat,\n        review.player_id,\n        playerText,\n        [reviewerId],\n        {\n            source: 'appearance_result',\n            dedupeKey: `appearance_result:${review.id || review.message_id || review.player_id}:${action}`,\n        }\n    );",
        'appearance.result_source'
    );
    return next;
}

function patchHistory(content) {
    let next = content;
    next = replaceExactly(
        next,
        "async function notifyPlayer(sock, fallbackChatId, playerId, text) {\n    try {\n        await sendPrivateText({ sock, playerId, text });",
        "async function notifyPlayer(sock, fallbackChatId, playerId, text, policy = {}) {\n    try {\n        await sendPrivateText({ sock, playerId, text, policy });",
        'history.notification_helper'
    );
    next = replaceExactly(
        next,
        "    await notifyPlayer(sock, idChat, targetId, [\n        '*Historia/persona precisa de ajuste.*',\n        '',\n        reason ? `Motivo: ${reason}` : 'A administracao pediu ajustes na historia/persona.',\n    ].join('\\n'));",
        "    await notifyPlayer(sock, idChat, targetId, [\n        '*Historia/persona precisa de ajuste.*',\n        '',\n        reason ? `Motivo: ${reason}` : 'A administracao pediu ajustes na historia/persona.',\n    ].join('\\n'), {\n        source: 'history_adjustment',\n        dedupeKey: `history_adjustment:${targetId}:${m?.key?.id || 'manual'}`,\n    });",
        'history.adjustment_source'
    );
    next = replaceExactly(
        next,
        "    await notifyPlayer(sock, idChat, targetId, [\n        '*Personagem liberado para o jogo.*',\n        '',\n        `Use *${COMMAND_PREFIX}atributos* para distribuir seus PB iniciais.`,\n    ].join('\\n'));",
        "    await notifyPlayer(sock, idChat, targetId, [\n        '*Personagem liberado para o jogo.*',\n        '',\n        `Use *${COMMAND_PREFIX}atributos* para distribuir seus PB iniciais.`,\n    ].join('\\n'), {\n        source: 'game_release',\n        dedupeKey: `game_release:${targetId}:${m?.key?.id || 'manual'}`,\n    });",
        'history.game_release_source'
    );
    next = replaceExactly(
        next,
        "    await notifyPlayer(sock, idChat, targetId, [\n        '*Acesso ao jogo bloqueado.*',\n        '',\n        reason ? `Motivo: ${reason}` : 'A administracao bloqueou temporariamente seu acesso aos sistemas de jogo.',\n    ].join('\\n'));",
        "    await notifyPlayer(sock, idChat, targetId, [\n        '*Acesso ao jogo bloqueado.*',\n        '',\n        reason ? `Motivo: ${reason}` : 'A administracao bloqueou temporariamente seu acesso aos sistemas de jogo.',\n    ].join('\\n'), {\n        source: 'game_block',\n        dedupeKey: `game_block:${targetId}:${m?.key?.id || 'manual'}`,\n    });",
        'history.game_block_source'
    );
    return next;
}

function patchGroups(content) {
    let next = content;
    next = replaceExactly(
        next,
        "async function sendOfficialSpellReviewInvite(sock, db, playerId, options = {}) {",
        "function buildSpellReviewPrivatePolicy(playerId, inviteIdentity) {\n    return {\n        source: 'spell_review_invite',\n        dedupeKey: `spell_review_invite:${playerId}:${inviteIdentity || 'current'}`,\n    };\n}\n\nasync function sendOfficialSpellReviewInvite(sock, db, playerId, options = {}) {",
        'groups.policy_helper'
    );
    next = replaceExactly(
        next,
        "    if (!inviteCode) return { ok: false, reason: 'missing_invite_code' };\n\n    let subject = 'Avaliação de Feitiços';",
        "    if (!inviteCode) return { ok: false, reason: 'missing_invite_code' };\n    const privatePolicy = buildSpellReviewPrivatePolicy(playerId, inviteCode);\n\n    let subject = 'Avaliação de Feitiços';",
        'groups.official_policy'
    );
    next = replaceExactly(
        next,
        "                message: {\n                    groupInvite: {\n                        inviteCode,\n                        inviteExpiration,\n                        text: 'Sua vez chegou na avaliação de feitiço. Entre pelo convite e mande a ficha no grupo.',\n                        jid: groupId,\n                        subject,\n                    },\n                },\n            });",
        "                message: {\n                    groupInvite: {\n                        inviteCode,\n                        inviteExpiration,\n                        text: 'Sua vez chegou na avaliação de feitiço. Entre pelo convite e mande a ficha no grupo.',\n                        jid: groupId,\n                        subject,\n                    },\n                },\n                policy: privatePolicy,\n            });",
        'groups.official_send_policy'
    );
    next = replaceExactly(
        next,
        "    const officialInvite = add?.ok\n        ? null\n        : await sendOfficialSpellReviewInvite(sock, db, playerId, { link, add });\n\n    const text = renderSpellReviewInviteMessage(link, { add, officialInvite });",
        "    const officialInvite = add?.ok\n        ? null\n        : await sendOfficialSpellReviewInvite(sock, db, playerId, { link, add });\n    const privatePolicy = buildSpellReviewPrivatePolicy(\n        playerId,\n        inviteCodeFromLink(link) || officialInvite?.inviteCode || 'current'\n    );\n\n    const text = renderSpellReviewInviteMessage(link, { add, officialInvite });",
        'groups.link_policy'
    );
    next = replaceExactly(
        next,
        "            const privateResult = await sendPrivateText({ sock, playerId: jid, text });",
        "            const privateResult = await sendPrivateText({\n                sock,\n                playerId: jid,\n                text,\n                policy: privatePolicy,\n            });",
        'groups.link_send_policy'
    );
    return next;
}

function patchExit(content) {
    let next = content;
    next = replaceExactly(
        next,
        "        await sendReply({ sock, idChat: player.id, text: renderRecentReleaseGraceMessage(link) });",
        "        await sendReply({\n            sock,\n            idChat: player.id,\n            text: renderRecentReleaseGraceMessage(link),\n            policy: {\n                source: 'community_exit_confirmation',\n                dedupeKey: `community_exit_grace:${player.id}:${player.jogo_liberado_at || 'current'}`,\n            },\n        });",
        'exit.recent_release_source'
    );
    next = replaceExactly(
        next,
        "    await db.run(\n        `INSERT INTO clover_exit_confirmations\n         (player_id, source_group_id, status, expires_at)\n         VALUES (?, ?, 'pending', datetime('now', '+72 hours'))`,\n        [player.id, groupId]\n    );\n\n    await sendReply({ sock, idChat: player.id, text: renderCommunityExitMessageClean() });",
        "    const created = await db.run(\n        `INSERT INTO clover_exit_confirmations\n         (player_id, source_group_id, status, expires_at)\n         VALUES (?, ?, 'pending', datetime('now', '+72 hours'))`,\n        [player.id, groupId]\n    );\n\n    await sendReply({\n        sock,\n        idChat: player.id,\n        text: renderCommunityExitMessageClean(),\n        policy: {\n            source: 'community_exit_confirmation',\n            dedupeKey: `community_exit:${player.id}:${created?.lastID || groupId}`,\n        },\n    });",
        'exit.confirmation_source'
    );
    next = replaceExactly(
        next,
        "    await sendReply({ sock, idChat: player.id, text: renderExitCancelledMessageClean() });",
        "    await sendReply({\n        sock,\n        idChat: player.id,\n        text: renderExitCancelledMessageClean(),\n        policy: {\n            source: 'community_exit_confirmation',\n            dedupeKey: `community_exit_cancel:${player.id}:${pending.id}`,\n        },\n    });",
        'exit.cancel_source'
    );
    next = replaceExactly(
        next,
        "async function sendPrivateExitReply({ sock, playerId, text, sendPrivateTextFn }) {\n    if (typeof sendPrivateTextFn === 'function') {\n        return sendPrivateTextFn({ sock, playerId, text });\n    }\n    return sendReply({ sock, idChat: playerId, text });\n}",
        "async function sendPrivateExitReply({ sock, playerId, text, sendPrivateTextFn }) {\n    const policy = { source: 'community_exit_reply' };\n    if (typeof sendPrivateTextFn === 'function') {\n        return sendPrivateTextFn({ sock, playerId, text, policy });\n    }\n    return sendReply({ sock, idChat: playerId, text, policy });\n}",
        'exit.reply_source'
    );
    return next;
}

const PATCHERS = Object.freeze({
    policy: patchPolicy,
    registration: patchRegistration,
    appearance: patchAppearance,
    history: patchHistory,
    groups: patchGroups,
    exit: patchExit,
});

function prepareChanges() {
    const changes = [];
    for (const [key, descriptor] of Object.entries(FILES)) {
        const absolutePath = path.join(ROOT, descriptor.path);
        const raw = fs.readFileSync(absolutePath, 'utf8');
        const eol = raw.includes('\r\n') ? '\r\n' : '\n';
        const canonical = normalizeLf(raw);
        const currentSha = gitBlobSha(canonical);
        if (currentSha !== descriptor.sha) {
            throw new Error(
                `${descriptor.path} divergiu. Esperado ${descriptor.sha}; atual ${currentSha}. `
                + 'Rebase/revisão manual obrigatória.'
            );
        }
        const patched = PATCHERS[key](canonical);
        if (patched === canonical) {
            throw new Error(`${descriptor.path}: nenhuma alteração foi preparada.`);
        }
        changes.push({ absolutePath, path: descriptor.path, raw, eol, patched });
    }
    return changes;
}

function main() {
    const args = new Set(process.argv.slice(2));
    const apply = args.has('--apply');
    const changes = prepareChanges();

    console.log('[pv-policy-sources] pré-condições aprovadas.');
    for (const change of changes) {
        console.log(`[pv-policy-sources] pronto: ${change.path}`);
    }

    if (!apply) {
        console.log('[pv-policy-sources] check concluído; nenhum arquivo alterado.');
        return;
    }

    const written = [];
    try {
        for (const change of changes) {
            fs.writeFileSync(change.absolutePath, restoreEol(change.patched, change.eol), 'utf8');
            written.push(change);
        }
        console.log(`[pv-policy-sources] ${written.length} arquivos atualizados com EOL preservado.`);
    } catch (error) {
        for (const change of written.reverse()) {
            fs.writeFileSync(change.absolutePath, change.raw, 'utf8');
        }
        throw error;
    }
}

try {
    main();
} catch (error) {
    console.error(`[pv-policy-sources] falha: ${error?.message || error}`);
    process.exitCode = 1;
}
