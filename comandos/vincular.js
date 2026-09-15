const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { isSameUser, normalizeJid } = require('../helpers/groupAccess');
const {
    canManagePlayer,
    describeTargetSource,
    ensureTargetResolverSchema,
    formatMention,
    getCanonicalPlayer,
    getRawPlayerById,
    isEmptyCharacterPlayer,
    linkPlayerTarget,
    mergePlayerIdentity,
    playerDisplayName,
    resolveTargetAndRest,
    resolveTargetPlayer,
} = require('../helpers/clover/commandTargetUtils');

function parseKeyValues(text) {
    const kv = {};
    const regex = /([A-Za-z0-9_]+)=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s]+)/g;
    let match = null;
    while ((match = regex.exec(String(text || '')))) {
        const key = String(match[1] || '').toLowerCase().trim();
        const value = String(match[2] || '').trim().replace(/^["']|["']$/g, '');
        if (key) kv[key] = value;
    }
    return kv;
}

function renderUsage() {
    return [
        '*♧┃VINCULAR 𖥔 CLOVER MULTICOLOR*',
        '     ── correção de identidade ──',
        '',
        '_`─( ✓ )───── Uso`_',
        '',
        `> ${COMMAND_PREFIX}vincular @player personagem="Nome do Personagem" tel=8599136380`,
        '',
        '> A menção e o telefone viram alias do player canônico.',
    ].join('\n');
}

function cleanCharacterName(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function phoneVariants(value) {
    const digits = String(value || '').replace(/\D/g, '');
    if (!digits) return [];
    const variants = new Set([digits]);
    if (!digits.startsWith('55') && digits.length >= 10 && digits.length <= 11) {
        variants.add(`55${digits}`);
    }
    return [...variants];
}

async function ensureShellPlayer(db, playerId, fallbackName) {
    const id = normalizeJid(playerId);
    if (!id) return null;

    let player = await getRawPlayerById(db, id);
    if (player) return player;

    const display = cleanCharacterName(fallbackName) || 'Cacador';
    await db.run(
        `INSERT OR IGNORE INTO jogadores
         (id, nome, display_name, personagem_nome, canonical_player_id, is_shadow, identity_status)
         VALUES (?, ?, ?, '-', ?, 0, 'active')`,
        [id, display, display, id]
    );
    player = await getRawPlayerById(db, id);
    return player;
}

async function updateCharacterIfEmpty(db, player, characterName) {
    const name = cleanCharacterName(characterName);
    if (!player?.id || !name || !isEmptyCharacterPlayer(player)) return player;

    await db.run(
        `UPDATE jogadores
         SET personagem_nome = ?,
             nome = CASE
                 WHEN nome IS NULL OR TRIM(nome) = '' OR nome IN ('-', '.', 'Cacador') THEN ?
                 ELSE nome
             END,
             display_name = CASE
                 WHEN display_name IS NULL OR TRIM(display_name) = '' OR display_name IN ('-', '.', 'Cacador') THEN ?
                 ELSE display_name
             END,
             canonical_player_id = COALESCE(canonical_player_id, id),
             is_shadow = 0,
             identity_status = 'active'
         WHERE id = ?`,
        [name, name, name, player.id]
    );

    return getCanonicalPlayer(db, player.id);
}

async function resolveExistingCharacter(db, characterName) {
    const name = cleanCharacterName(characterName);
    if (!name) return null;
    const resolved = await resolveTargetPlayer(db, null, name, { mechanical: true }).catch(() => null);
    return resolved?.ok ? resolved : null;
}

async function resolveExistingPhone(db, phone) {
    for (const variant of phoneVariants(phone)) {
        const resolved = await resolveTargetPlayer(db, null, variant, { mechanical: true }).catch(() => null);
        if (resolved?.ok) return resolved;
    }
    return null;
}

async function resolveLooseTarget(db, targetData, characterName) {
    const rawTarget = String(targetData.targetId || targetData.targetText || '').trim();
    if (!rawTarget) return null;

    let resolved = await resolveTargetPlayer(db, targetData.targetId, targetData.targetText, { allowShadow: true }).catch(() => null);
    if (resolved?.ok) return resolved;

    if (targetData.targetId) {
        const shell = await ensureShellPlayer(db, targetData.targetId, characterName);
        if (!shell) return null;
        const canonical = await getCanonicalPlayer(db, shell.id, { skipSelfHydrate: true }) || shell;
        resolved = {
            ok: true,
            player: canonical,
            rawPlayer: shell,
            source: targetData.source || 'created',
        };
    }
    return resolved;
}

async function maybeMergeRawIntoCanonical(db, rawPlayer, canonicalPlayer, { label, actorId, refused, merged }) {
    if (!rawPlayer?.id || !canonicalPlayer?.id || isSameUser(rawPlayer.id, canonicalPlayer.id)) {
        return;
    }

    if (!isEmptyCharacterPlayer(rawPlayer) && Number(rawPlayer.is_shadow || 0) !== 1) {
        refused.push(`${label}: já aponta para ${playerDisplayName(rawPlayer, rawPlayer.id)}.`);
        return;
    }

    const result = await mergePlayerIdentity(db, {
        origin: rawPlayer.id,
        destination: canonicalPlayer.id,
        reason: `Vínculo automático por ${label}`,
        actorId,
    });
    merged.push(result.origin.id);
}

module.exports = {
    nome: `${COMMAND_PREFIX}vincular`,
    aliases: [
        `${COMMAND_PREFIX}link`,
        `${COMMAND_PREFIX}associar`,
    ],
    descricao: 'Vincula menção/telefone a um personagem canônico e corrige espelhos.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        if (!await canManagePlayer(sock, idChat, idJogador)) {
            await sendReply({ sock, idChat, m, text: 'Apenas ADM do grupo ou Owner pode usar esse comando.' });
            return;
        }

        await ensureTargetResolverSchema(db);

        const targetData = resolveTargetAndRest(body, m);
        const kv = parseKeyValues(body);
        const characterName = cleanCharacterName(kv.personagem || kv.personagem_nome || kv.player || kv.nome || '');
        const phone = String(kv.tel || kv.telefone || kv.phone || '').trim();
        const aliasInput = String(targetData.targetId || targetData.targetText || '').trim();

        if (!aliasInput || !characterName) {
            await sendReply({ sock, idChat, m, text: renderUsage() });
            return;
        }

        const existingCharacter = await resolveExistingCharacter(db, characterName);
        const existingPhone = existingCharacter ? null : await resolveExistingPhone(db, phone);
        const targetResolved = await resolveLooseTarget(db, targetData, characterName);

        if (!existingCharacter && !existingPhone && !targetResolved?.ok) {
            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    '*♧┃VINCULAR RECUSADO 𖥔 CLOVER MULTICOLOR*',
                    '',
                    '> Não consegui encontrar nem criar o alvo marcado.',
                    '> Use menção real ou telefone completo.',
                ].join('\n'),
            });
            return;
        }

        let player = existingCharacter?.player || existingPhone?.player || targetResolved.player;
        player = await updateCharacterIfEmpty(db, player, characterName);
        player = await getCanonicalPlayer(db, player.id) || player;

        const linked = [];
        const merged = [];
        const refused = [];

        const rawDirect = targetData.targetId ? await getRawPlayerById(db, targetData.targetId) : null;
        await maybeMergeRawIntoCanonical(db, rawDirect || targetResolved?.rawPlayer, player, {
            label: targetData.source === 'mention' ? 'menção' : 'alvo',
            actorId: idJogador,
            refused,
            merged,
        });

        if (targetData.source === 'mention' && targetData.targetId) {
            linked.push(await linkPlayerTarget(db, { type: 'whatsapp_mention', value: targetData.targetId, label: targetData.targetId }, player.id, {
                createdBy: idJogador,
                kind: 'whatsapp_mention',
                source: 'whatsapp_mention',
                confidence: 120,
            }));
        } else {
            linked.push(await linkPlayerTarget(db, aliasInput, player.id, {
                createdBy: idJogador,
                kind: 'manual',
                source: 'manual',
                confidence: 100,
            }));
        }

        for (const variant of phoneVariants(phone)) {
            const found = await resolveTargetPlayer(db, null, variant, { allowShadow: true }).catch(() => null);
            await maybeMergeRawIntoCanonical(db, found?.rawPlayer || found?.player, player, {
                label: `telefone ${variant}`,
                actorId: idJogador,
                refused,
                merged,
            });
            linked.push(await linkPlayerTarget(db, { type: 'phone', value: variant, label: variant }, player.id, {
                createdBy: idJogador,
                kind: 'phone',
                source: 'phone',
                confidence: 110,
            }));
        }

        linked.push(await linkPlayerTarget(db, { type: 'character', value: characterName, label: characterName }, player.id, {
            createdBy: idJogador,
            kind: 'character',
            source: 'character',
            confidence: 100,
        }));

        player = await getCanonicalPlayer(db, player.id) || player;

        if (refused.length) {
            await sendReply({
                sock,
                idChat,
                m,
                mentions: [player.id],
                text: [
                    '*♧┃VINCULAR COM ALERTA 𖥔 CLOVER MULTICOLOR*',
                    '     ── revise antes de repetir ──',
                    '',
                    '_`─( ! )───── Bloqueios`_',
                    '',
                    ...refused.map((item) => `> ${item}`),
                    '',
                    '> O vínculo perigoso não foi feito.',
                ].join('\n'),
            });
            return;
        }

        await sendReply({
            sock,
            idChat,
            m,
            mentions: [player.id],
            text: [
                '*♧┃VINCULAR 𖥔 CLOVER MULTICOLOR*',
                '     ── vínculo atualizado ──',
                '',
                '_`─( ✓ )───── Registro`_',
                '',
                `*Personagem:* ${playerDisplayName(player, player.id)}`,
                `*Player ID canônico:* ${player.id}`,
                `*Fonte:* ${describeTargetSource((existingCharacter || existingPhone || targetResolved).source)}`,
                `*Vínculo principal:* ${formatMention(player.id)}`,
                `*Aliases atualizados:* ${linked.reduce((sum, item) => sum + Number(item.aliasKeys?.length || 0), 0)}`,
                merged.length ? `*Espelhos mesclados:* ${merged.length}` : null,
                '',
                '> Telefone, menção e @lid agora são alias. Ação mecânica segue no player_id canônico.',
            ].filter(Boolean).join('\n'),
        });
    },
};
