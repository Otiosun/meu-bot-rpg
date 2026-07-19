const { COMMAND_PREFIX } = require('../config/bot');
const { syncArchiveCardForPlayer } = require('../helpers/clover/archiveManager');

async function syncArchiveSafely(sock, db, playerId) {
    try {
        await syncArchiveCardForPlayer({ sock, db, playerId });
    } catch (error) {
        console.log('[arquivo] Nao consegui sincronizar ficha atualizada:', error?.message || error);
    }
}

function normalizeFieldKey(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/ɑ/g, 'a')
        .replace(/ı/g, 'i')
        .replace(/ɾ/g, 'r')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z]/g, '');
}

function parseNumber(value) {
    const original = String(value || '').toLowerCase();
    let number = parseInt(original.replace(/\D/g, ''), 10) || 0;
    if (original.includes('b') || original.includes('bilh')) number *= 1000000000;
    else if (original.includes('m') || original.includes('milh')) number *= 1000000;
    else if (original.includes('k')) number *= 1000;
    return number;
}

function parseFichaPatch(text) {
    const patch = new Map();
    let ignoredMoney = false;

    for (const line of String(text || '').split('\n')) {
        if (!line.includes(':')) continue;

        const parts = line.split(':');
        const key = normalizeFieldKey(parts[0]);
        const value = parts.slice(1).join(':').trim().replace(/^-\s*/, '');

        if (key.includes('inheiro') || key.includes('yull')) {
            ignoredMoney = true;
            continue;
        }

        if (key.includes('strela')) patch.set('estrelas', parseNumber(value));
        else if (key.includes('orca')) patch.set('forca', parseNumber(value));
        else if (key.includes('elocidad')) patch.set('velocidade', parseNumber(value));
        else if (key.includes('esistencia')) patch.set('resistencia', parseNumber(value));
        else if (key.includes('eflexo')) patch.set('reflexos', parseNumber(value));
        else if (key.includes('oder') || key.includes('agico') || key === 'pm') patch.set('poder_magico', parseNumber(value));
        else if (key.includes('ana')) patch.set('mana', parseNumber(value));
        else if (key.includes('ome')) patch.set('nome', value || '-');
        else if (key.includes('dade')) patch.set('idade', value || '-');
        else if (key.includes('eino')) patch.set('reino', value || '-');
        else if (key.includes('lasse')) patch.set('classe', value || '-');
        else if (key.includes('amili') || key.includes('mili')) patch.set('familia', value || '-');
        else if (key.includes('aca')) patch.set('raca', value || '-');
        else if (key.includes('rimorio') || key.includes('imorio')) patch.set('grimorio', value || '-');
        else if (key.includes('agia')) patch.set('magia', value || '-');
        else if (key.includes('orma')) patch.set('formas', value || '-');
        else if (key.includes('istoria')) patch.set('historia', value || '-');
        else if (key.includes('parencia') || key.includes('arencia')) patch.set('aparencia', value || '-');
        else if (key.includes('squadrao')) patch.set('esquadrao', value || '-');
    }

    return { patch, ignoredMoney };
}

module.exports = {
    nome: `${COMMAND_PREFIX}atualizar`,
    oculto: true,
    executar: async ({ sock, idChat, idJogador, texto, db }) => {
        try {
            const player = await db.get(
                'SELECT nome, personagem_nome FROM jogadores WHERE id = ?',
                [idJogador]
            );

            if (!player) {
                await sock.sendMessage(idChat, { text: '⚠️ Jogador não encontrado no sistema.' });
                return;
            }

            const { patch, ignoredMoney } = parseFichaPatch(texto);

            if (patch.size === 0) {
                const suffix = ignoredMoney
                    ? '\nO saldo de Yulls foi preservado e deve ser alterado apenas pelos comandos econômicos.'
                    : '';
                await sock.sendMessage(idChat, {
                    text: `⚠️ Nenhum campo válido da ficha foi encontrado.${suffix}`,
                });
                return;
            }

            const columns = [...patch.keys()];
            const assignments = columns.map((column) => `${column} = ?`).join(', ');
            const values = columns.map((column) => patch.get(column));

            await db.run(
                `UPDATE jogadores SET ${assignments} WHERE id = ?`,
                [...values, idJogador]
            );

            await syncArchiveSafely(sock, db, idJogador);

            const updatedName = patch.get('nome')
                || player.personagem_nome
                || player.nome
                || 'personagem';
            const moneyNotice = ignoredMoney
                ? '\n💰 O saldo de Yulls foi preservado; esta ficha não altera dinheiro.'
                : '';

            await sock.sendMessage(idChat, {
                text: `✅ Ficha de *${updatedName}* atualizada no sistema!\nUse o comando ${COMMAND_PREFIX}ficha para conferir.${moneyNotice}`,
            });
        } catch (error) {
            console.error('❌ Erro no atualizar.js:', error);
            await sock.sendMessage(idChat, { text: '⚠️ Ocorreu um erro ao processar sua ficha.' });
        }
    },
    _test: {
        normalizeFieldKey,
        parseFichaPatch,
        parseNumber,
    },
};
