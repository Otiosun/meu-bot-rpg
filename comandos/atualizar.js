const { COMMAND_PREFIX } = require('../config/bot');
const { syncArchiveCardForPlayer } = require('../helpers/clover/archiveManager');

async function syncArchiveSafely(sock, db, playerId) {
    try {
        await syncArchiveCardForPlayer({ sock, db, playerId });
    } catch (error) {
        console.log('[arquivo] Nao consegui sincronizar ficha atualizada:', error?.message || error);
    }
}

module.exports = {
    nome: `${COMMAND_PREFIX}atualizar`,
    oculto: true,
    executar: async ({ sock, idChat, idJogador, texto, db }) => {
        try {
            // Separa o texto linha por linha
            const linhas = texto.split('\n');

            // Variáveis padrão vazias
            let nome = '-', idade = '-', reino = '-', classe = '-', familia = '-';
            let raca = '-', grimorio = '-', magia = '-', formas = '-', historia = '-', aparencia = '-';
            let esquadrao = '-';
            let dinheiro = 0, estrelas = 0, forca = 0, velocidade = 0, resistencia = 0;
            let reflexos = 0, poder_magico = 0, mana = 0;

            // Função ninja para entender números como "5 bilhões" ou "5k"
            const converterNumero = (textoOriginal) => {
                let numTexto = textoOriginal.toLowerCase();
                let num = parseInt(numTexto.replace(/\D/g, '')) || 0; // Pega só os números
                if (numTexto.includes('b') || numTexto.includes('bilh')) num *= 1000000000;
                else if (numTexto.includes('m') || numTexto.includes('milh')) num *= 1000000;
                else if (numTexto.includes('k')) num *= 1000;
                return num;
            };

            // Percorre cada linha da mensagem
            for (let linha of linhas) {
                if (!linha.includes(':')) continue; // Ignora as linhas de enfeite sem ":"

                let partes = linha.split(':');
                let chaveOriginal = partes[0];
                let valorOriginal = partes.slice(1).join(':').trim().replace(/^-\s*/, ''); 

                // Limpeza absoluta da chave
                let chaveLimpa = chaveOriginal
                    .normalize("NFKD") 
                    .replace(/ɑ/g, 'a')
                    .replace(/ı/g, 'i')
                    .replace(/ɾ/g, 'r')
                    .replace(/[\u0300-\u036f]/g, "") 
                    .toLowerCase()
                    .replace(/[^a-z]/g, ''); // Deixa apenas letras

                // === EXTRAÇÃO DOS STATUS PRIMEIRO ===
                // Lemos os status antes para palavras como "velocidade" não ativarem a "idade"
                if (chaveLimpa.includes('inheiro')) dinheiro = converterNumero(valorOriginal);
                else if (chaveLimpa.includes('strela')) estrelas = converterNumero(valorOriginal);
                else if (chaveLimpa.includes('orca')) forca = converterNumero(valorOriginal);
                else if (chaveLimpa.includes('elocidad')) velocidade = converterNumero(valorOriginal);
                else if (chaveLimpa.includes('esistencia')) resistencia = converterNumero(valorOriginal);
                else if (chaveLimpa.includes('eflexo')) reflexos = converterNumero(valorOriginal);
                else if (chaveLimpa.includes('oder') || chaveLimpa.includes('agico') || chaveLimpa === 'pm') poder_magico = converterNumero(valorOriginal);
                else if (chaveLimpa.includes('ana')) mana = converterNumero(valorOriginal);
                
                // === INFORMAÇÕES PESSOAIS DEPOIS ===
                else if (chaveLimpa.includes('ome')) nome = valorOriginal;
                else if (chaveLimpa.includes('dade')) idade = valorOriginal; // Agora está seguro!
                else if (chaveLimpa.includes('eino')) reino = valorOriginal;
                else if (chaveLimpa.includes('lasse')) classe = valorOriginal;
                else if (chaveLimpa.includes('amili') || chaveLimpa.includes('mili')) familia = valorOriginal;
                else if (chaveLimpa.includes('aca')) raca = valorOriginal;
                else if (chaveLimpa.includes('rimorio') || chaveLimpa.includes('imorio')) grimorio = valorOriginal;
                else if (chaveLimpa.includes('agia')) magia = valorOriginal;
                else if (chaveLimpa.includes('orma')) formas = valorOriginal;
                else if (chaveLimpa.includes('istoria')) historia = valorOriginal;
                else if (chaveLimpa.includes('parencia') || chaveLimpa.includes('arencia')) aparencia = valorOriginal;
                else if (chaveLimpa.includes('squadrao')) esquadrao = valorOriginal;
            }

            console.log(`[DEBUG ATUALIZAR] Força: ${forca} | Vel: ${velocidade} | Res: ${resistencia} | P.M: ${poder_magico}`);

            // Atualiza TUDO no banco de dados
            await db.run(`
                UPDATE jogadores 
                SET nome = ?, idade = ?, reino = ?, classe = ?, familia = ?, 
                    raca = ?, grimorio = ?, magia = ?, formas = ?, historia = ?, 
                    aparencia = ?, dinheiro = ?, esquadrao = ?, estrelas = ?, 
                    forca = ?, velocidade = ?, resistencia = ?, reflexos = ?, 
                    poder_magico = ?, mana = ?
                WHERE id = ?
            `, [nome, idade, reino, classe, familia, raca, grimorio, magia, formas, historia, aparencia, 
                dinheiro, esquadrao, estrelas, forca, velocidade, resistencia, reflexos, poder_magico, mana, idJogador]);

            await syncArchiveSafely(sock, db, idJogador);

            await sock.sendMessage(idChat, { text: `✅ Ficha de *${nome}* analisada e salva no sistema!\nUse o comando ${COMMAND_PREFIX}ficha para conferir.` });

        } catch (erro) {
            console.error("❌ Erro no atualizar.js:", erro);
            await sock.sendMessage(idChat, { text: "⚠️ Ocorreu um erro ao processar sua ficha." });
        }
    }
};
