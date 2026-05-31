const { COMMAND_PREFIX } = require('../config/bot');

module.exports = {
    nome: `${COMMAND_PREFIX}perfil`,
    descricao: 'Mostra um resumo visual do seu personagem salvo.',
    executar: async ({ sock, idChat, idJogador, db }) => {
        try {
            // Busca o jogador no banco de dados
            const jogador = await db.get('SELECT * FROM jogadores WHERE id = ?', [idJogador]);

            if (!jogador) {
                return await sock.sendMessage(idChat, { text: `⚠️ Você ainda não tem uma ficha! Use o comando ${COMMAND_PREFIX}atualizar com sua ficha para começar.` });
            }

            // Pega os status
            const forca = jogador.forca || 0;
            const velocidade = jogador.velocidade || 0;
            const resistencia = jogador.resistencia || 0;
            const reflexos = jogador.reflexos || 0;
            const poder_magico = jogador.poder_magico || 0;
            const mana = jogador.mana || 0;

            // === GERADOR DE COR BASEADO NO WHATSAPP ===
            const numeroLimpo = idJogador.replace(/\D/g, ''); 
            const digito = parseInt(numeroLimpo.slice(-1)) || 0;

            // Paleta de 10 Cores Elementais (O 'fundo' agora é bem transparente, focando o brilho na 'borda')
            const coresRPG = [
                { borda: 'rgba(255, 50, 50, 1)',   fundo: 'rgba(255, 50, 50, 0.2)' },   // 0: Vermelho Vivo
                { borda: 'rgba(54, 162, 235, 1)',  fundo: 'rgba(54, 162, 235, 0.2)' },  // 1: Azul Água
                { borda: 'rgba(46, 204, 113, 1)',  fundo: 'rgba(46, 204, 113, 0.2)' },  // 2: Verde Vento
                { borda: 'rgba(153, 102, 255, 1)', fundo: 'rgba(153, 102, 255, 0.2)' }, // 3: Roxo Trevas
                { borda: 'rgba(255, 205, 86, 1)',  fundo: 'rgba(255, 205, 86, 0.2)' },  // 4: Amarelo Raio
                { borda: 'rgba(255, 120, 0, 1)',   fundo: 'rgba(255, 120, 0, 0.2)' },   // 5: Laranja Magma
                { borda: 'rgba(0, 255, 255, 1)',   fundo: 'rgba(0, 255, 255, 0.2)' },   // 6: Ciano Gelo/Neon
                { borda: 'rgba(231, 76, 60, 1)',   fundo: 'rgba(231, 76, 60, 0.2)' },   // 7: Carmesim Sangue
                { borda: 'rgba(170, 170, 170, 1)', fundo: 'rgba(170, 170, 170, 0.2)' }, // 8: Escuro Aço
                { borda: 'rgba(255, 50, 150, 1)',  fundo: 'rgba(255, 50, 150, 0.2)' }   // 9: Rosa Encantamento
            ];

            // Se você quisesse que FOSSE SEMPRE VERMELHO para todo mundo, era só trocar a linha abaixo por:
            // const corDoJogador = { borda: 'rgba(255, 0, 0, 1)', fundo: 'rgba(255, 0, 0, 0.2)' };
            const corDoJogador = coresRPG[digito];

            const maiorStatus = Math.max(forca, velocidade, resistencia, reflexos, poder_magico, mana);
            const tetoGrafico = maiorStatus > 0 ? maiorStatus : 100; 

            // Configuração do Gráfico de Radar
            const configGrafico = {
                type: 'radar',
                data: {
                    labels: ['Força', 'Velocidade', 'Resistência', 'Reflexos', 'Poder Mágico', 'Mana'],
                    datasets: [{
                        label: jogador.nome,
                        data: [forca, velocidade, resistencia, reflexos, poder_magico, mana],
                        backgroundColor: corDoJogador.fundo, // Cor clarinha dentro do desenho
                        borderColor: corDoJogador.borda,     // A LINHA DOS ATRIBUTOS (agora super forte)
                        borderWidth: 4,                      // Deixei a linha bem mais grossa para destacar!
                        pointBackgroundColor: corDoJogador.borda, // Bolinhas nas pontas da mesma cor
                        pointBorderColor: '#fff',
                        pointHoverBackgroundColor: '#fff',
                        pointHoverBorderColor: corDoJogador.borda
                    }]
                },
                options: {
                    scale: {
                        ticks: {
                            beginAtZero: true,
                            max: tetoGrafico,
                            display: false 
                        },
                        pointLabels: {
                            fontSize: 16,
                            fontColor: '#ffffff'
                        },
                        gridLines: {
                            color: 'rgba(255, 255, 255, 0.2)' // Linhas do hexágono (sempre cinza claro)
                        },
                        angleLines: {
                            color: 'rgba(255, 255, 255, 0.2)' // Linhas do centro pras pontas (sempre cinza claro)
                        }
                    },
                    legend: {
                        labels: {
                            fontColor: '#ffffff',
                            fontSize: 18
                        }
                    }
                }
            };

            // Fundo da imagem continua escurão: bkg=rgba(20,20,20,1)
            const urlGrafico = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(configGrafico))}&bkg=rgba(20,20,20,1)&w=600&h=600`;

            const textoPerfil = `*🛡️ PERFIL DE ${jogador.nome.toUpperCase()} 🛡️*\n\n` +
                                `*📖 Classe:* ${jogador.classe}\n` +
                                `*🏰 Reino:* ${jogador.reino}\n` +
                                `*🪄 Magia:* ${jogador.magia}\n` +
                                `*💰 Dinheiro:* ${jogador.dinheiro}\n\n` +
                                `*📊 STATUS PRINCIPAIS*\n` +
                                `💪 Força: ${forca}\n` +
                                `⚡ Velocidade: ${velocidade}\n` +
                                `🛡️ Resistência: ${resistencia}\n` +
                                `👁️ Reflexos: ${reflexos}\n` +
                                `✨ Poder Mágico: ${poder_magico}\n` +
                                `💧 Mana: ${mana}`;

            await sock.sendMessage(idChat, {
                image: { url: urlGrafico },
                caption: textoPerfil
            });

        } catch (erro) {
            console.error("❌ Erro no perfil.js:", erro);
            await sock.sendMessage(idChat, { text: "⚠️ Ocorreu um erro ao gerar seu perfil." });
        }
    }
};
