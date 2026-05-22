const { COMMAND_PREFIX } = require('../config/bot');

module.exports = {
    nome: `${COMMAND_PREFIX}avaliar`,
    descricao: 'O Mestre de RPG avalia sua cena (suporta imagens).',
    executar: async ({ sock, m, idChat, idJogador, texto, db, model, P, downloadMediaMessage }) => {
        const comandoBase = `${COMMAND_PREFIX}avaliar`;
        let cena = texto.slice(comandoBase.length).trim();

        if (!cena && m.message?.imageMessage) cena = "Avalie esta imagem no contexto de uma cena de RPG.";
        if (!cena) return sock.sendMessage(idChat, { text: `❌ Escreva uma cena ou mande uma foto com a legenda ${COMMAND_PREFIX}avaliar` });

        await sock.sendMessage(idChat, { text: '🧠 *O Mestre está analisando a cena...*' });

        try {
            const p = await db.get('SELECT * FROM jogadores WHERE id = ?', [idJogador]);
            if (!p) return sock.sendMessage(idChat, { text: `❌ Crie sua ficha com ${COMMAND_PREFIX}registrar antes.` });

            const textoParaIA = `[SISTEMA - STATUS DO JOGADOR: Força: ${p.forca}, Agilidade: ${p.agilidade}]\nCENA DO JOGADOR:\n${cena}`;
            let conteudoParaIA;

            if (m.message?.imageMessage) {
                const buffer = await downloadMediaMessage(m, 'buffer', {}, { logger: P({ level: 'silent' }) });
                conteudoParaIA = [textoParaIA, { inlineData: { data: buffer.toString("base64"), mimeType: m.message.imageMessage.mimetype } }];
            } else {
                conteudoParaIA = [textoParaIA];
            }

            const result = await model.generateContent(conteudoParaIA);
            let respostaIA = result.response.text();
            
            const regexPontos = /\[PONTOS:(\d+)\]/i;
            const match = respostaIA.match(regexPontos);

            if (match) {
                const pontosGanhos = parseInt(match[1]);
                await db.run(`UPDATE jogadores SET pontos = pontos + ? WHERE id = ?`, [pontosGanhos, idJogador]);
                respostaIA = respostaIA.replace(regexPontos, '').trim(); 
                await sock.sendMessage(idChat, { text: `🎭 *AVALIAÇÃO*\n\n${respostaIA}\n\n✨ Ganhou +${pontosGanhos} ponto(s)!` });
            } else {
                await sock.sendMessage(idChat, { text: `🎭 *AVALIAÇÃO*\n\n${respostaIA}` });
            }
        } catch (err) {
            console.log(err.message);
            await sock.sendMessage(idChat, { text: '⚠️ Erro ao consultar o Mestre.' });
        }
    }
};
