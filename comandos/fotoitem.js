'use strict';

const sharp = require('sharp');
const Pino = require('pino');

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 180 * 1024;
const MAX_EDGE = 720;
const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);

class ItemPhotoError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'ItemPhotoError';
        this.code = code;
        this.details = details;
    }
}

function safeJsonObject(value) {
    if (!value) return {};
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function normalizeSearch(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}

function parseRequest(body) {
    const source = String(body || '').trim();
    const removeMatch = source.match(/^(?:remover|remove|apagar|excluir)\s+(.+)$/i);
    return {
        remove: Boolean(removeMatch),
        target: String(removeMatch?.[1] || source).trim(),
    };
}

async function listOwnedItems(db, playerId) {
    return db.all(
        `SELECT id, player_id, item_name, quantity, status, equipped_slot, properties_json
         FROM clover_inventory_items
         WHERE player_id = ?
         ORDER BY id DESC`,
        [playerId]
    );
}

async function resolveOwnedItem(db, playerId, target) {
    const query = String(target || '').trim();
    if (!query) {
        throw new ItemPhotoError('missing_item', 'Informe o nome ou o número do item.');
    }

    const rows = await listOwnedItems(db, playerId);
    const numericMatch = query.match(/^#?(\d+)$/);
    if (numericMatch) {
        const id = Number(numericMatch[1]);
        const item = rows.find((row) => Number(row.id) === id);
        if (!item) throw new ItemPhotoError('item_not_found', 'Esse item não foi encontrado no seu inventário.');
        return item;
    }

    const normalized = normalizeSearch(query);
    const exact = rows.filter((row) => normalizeSearch(row.item_name) === normalized);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) {
        throw new ItemPhotoError('ambiguous_item', 'Há mais de um exemplar com esse nome. Use o número do item.', {
            candidates: exact.slice(0, 8),
        });
    }

    const partial = rows.filter((row) => normalizeSearch(row.item_name).includes(normalized));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) {
        throw new ItemPhotoError('ambiguous_item', 'Encontrei vários itens parecidos. Use o número do item.', {
            candidates: partial.slice(0, 8),
        });
    }

    throw new ItemPhotoError('item_not_found', 'Nenhum item do seu inventário corresponde a esse nome.');
}

async function optimizeItemImage(buffer, mimeType = '') {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw new ItemPhotoError('missing_image', 'Envie uma imagem junto do comando.');
    }
    if (buffer.length > MAX_INPUT_BYTES) {
        throw new ItemPhotoError('image_too_large', 'A imagem original ultrapassa 8 MB.');
    }

    const normalizedMime = String(mimeType || '').toLowerCase();
    if (normalizedMime && !ALLOWED_MIME_TYPES.has(normalizedMime)) {
        throw new ItemPhotoError('invalid_image_type', 'Use uma imagem PNG, JPG ou WEBP.');
    }

    let metadata;
    try {
        metadata = await sharp(buffer, { failOn: 'error', limitInputPixels: 25_000_000 }).metadata();
    } catch {
        throw new ItemPhotoError('invalid_image', 'O arquivo enviado não pôde ser aberto como imagem.');
    }

    if (!['png', 'jpeg', 'webp'].includes(String(metadata.format || '').toLowerCase())) {
        throw new ItemPhotoError('invalid_image_type', 'Use uma imagem PNG, JPG ou WEBP.');
    }

    for (const quality of [82, 74, 66, 58, 50, 42]) {
        const output = await sharp(buffer, { failOn: 'error', limitInputPixels: 25_000_000 })
            .rotate()
            .resize({
                width: MAX_EDGE,
                height: MAX_EDGE,
                fit: 'inside',
                withoutEnlargement: true,
            })
            .webp({ quality, effort: 4 })
            .toBuffer();

        if (output.length <= MAX_OUTPUT_BYTES) {
            return `data:image/webp;base64,${output.toString('base64')}`;
        }
    }

    throw new ItemPhotoError(
        'optimized_image_too_large',
        'A imagem continuou pesada depois da otimização. Use uma imagem mais simples ou já recortada.'
    );
}

async function saveItemPhoto(db, playerId, itemId, image) {
    const row = await db.get(
        `SELECT id, player_id, item_name, properties_json
         FROM clover_inventory_items
         WHERE id = ? AND player_id = ?`,
        [itemId, playerId]
    );
    if (!row) throw new ItemPhotoError('item_not_found', 'Esse item não foi encontrado no seu inventário.');

    const properties = safeJsonObject(row.properties_json);
    delete properties.imagem;
    delete properties.image_url;
    delete properties.imageUrl;

    if (image) {
        properties.image = image;
        properties.player_image_updated_at = new Date().toISOString();
        properties.player_image_source = 'whatsapp_upload';
    } else {
        delete properties.image;
        delete properties.player_image_updated_at;
        delete properties.player_image_source;
    }

    const result = await db.run(
        `UPDATE clover_inventory_items
         SET properties_json = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND player_id = ?`,
        [JSON.stringify(properties), itemId, playerId]
    );
    if (!Number(result?.changes || 0)) {
        throw new ItemPhotoError('item_not_found', 'Não foi possível atualizar esse item.');
    }

    return {
        id: Number(row.id),
        name: row.item_name || 'Item',
        image: image || null,
        properties,
    };
}

function renderUsage() {
    return [
        '♧┃𝐅𝐎𝐓𝐎 𝐃𝐎 𝐈𝐓𝐄𝐌 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫',
        '     ──  imagem do exemplar real  ──',
        '',
        '_`─( ✦ )───── 𝗔𝗱𝗶𝗰𝗶𝗼𝗻𝗮𝗿 𝗼𝘂 𝘁𝗿𝗼𝗰𝗮𝗿`_',
        '',
        `Envie uma imagem com a legenda *${COMMAND_PREFIX}fotoitem nome ou número*.` ,
        '',
        `> Exemplo: *${COMMAND_PREFIX}fotoitem 40*`,
        `> Exemplo: *${COMMAND_PREFIX}fotoitem Espada Celestial*`,
        '',
        '_`─( × )───── 𝗥𝗲𝗺𝗼𝘃𝗲𝗿`_',
        '',
        `*${COMMAND_PREFIX}fotoitem remover 40*`,
        '',
        'ⓘ A foto fica no item real. Se ele já estiver anunciado, a banca muda sem cancelar a venda e sem cobrar outra taxa.',
    ].join('\n');
}

function renderCandidates(error) {
    const candidates = Array.isArray(error?.details?.candidates) ? error.details.candidates : [];
    if (!candidates.length) return error.message;
    return [
        error.message,
        '',
        ...candidates.map((item) => `• *#${item.id}* — ${item.item_name}`),
    ].join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}fotoitem`,
    aliases: [`${COMMAND_PREFIX}imagemitem`, `${COMMAND_PREFIX}foto-item`],
    descricao: 'Adiciona, troca ou remove a foto de um item próprio do inventário.',
    executar: async ({ sock, m, idChat, idJogador, db, body, downloadMediaMessage, P }) => {
        try {
            const request = parseRequest(body);
            if (!request.target) {
                await sendReply({ sock, idChat, m, text: renderUsage() });
                return;
            }

            const item = await resolveOwnedItem(db, idJogador, request.target);

            if (request.remove) {
                const updated = await saveItemPhoto(db, idJogador, item.id, null);
                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: `✅ Foto removida de *#${updated.id} — ${updated.name}*.\n\nA banca volta a usar a imagem padrão do item, quando existir.`,
                });
                return;
            }

            const imageMessage = m?.message?.imageMessage;
            if (!imageMessage || typeof downloadMediaMessage !== 'function') {
                await sendReply({ sock, idChat, m, text: renderUsage() });
                return;
            }

            const buffer = await downloadMediaMessage(
                m,
                'buffer',
                {},
                {
                    logger: (P || Pino)({ level: 'silent' }),
                    reuploadRequest: sock.updateMediaMessage,
                }
            );
            const image = await optimizeItemImage(buffer, imageMessage.mimetype);
            const updated = await saveItemPhoto(db, idJogador, item.id, image);

            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    `✅ Foto salva em *#${updated.id} — ${updated.name}*.` ,
                    '',
                    'A imagem já vale para o exemplar real e para qualquer anúncio ativo dele.',
                    'Atualize a página do Mercado para conferir.',
                ].join('\n'),
            });
        } catch (error) {
            const known = error instanceof ItemPhotoError;
            console.error('[fotoitem]', error?.stack || error?.message || error);
            await sendReply({
                sock,
                idChat,
                m,
                text: known ? `⚠️ ${renderCandidates(error)}` : '⚠️ Não foi possível salvar a foto desse item.',
            });
        }
    },
    _test: {
        ItemPhotoError,
        normalizeSearch,
        optimizeItemImage,
        parseRequest,
        resolveOwnedItem,
        safeJsonObject,
        saveItemPhoto,
    },
};
