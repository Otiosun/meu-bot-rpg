const { COMMAND_PREFIX, MAX_PLAYER_ROLLS } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { isOwner } = require('../helpers/groupAccess');
const { canManagePlayer } = require('../helpers/clover/commandTargetUtils');
const { PHASES, getPlayerPhase } = require('../helpers/clover/playerPhase');
const { renderPostFichaHelp } = require('../helpers/clover/playerMenuMessages');

function commandLine(command, description) {
    return [`*̣${command}*`, `> ${description}`];
}

function renderCommandPairs(pairs) {
    return pairs.flatMap(([command, description]) => commandLine(command, description));
}

function renderReceptionMenu() {
    return [
        '♧┃𝐌𝐄𝐍𝐔 𝐃𝐀 𝐑𝐄𝐂𝐄𝐏𝐂̧𝐀̃𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫',
        '     ──  primeiros passos ᥱ criação do personagem  ──',
        '',
        '_`─( 𖥔 )───── 𝗥𝗲𝗰𝗲𝗽𝗰̧𝗮̃𝗼`_',
        '',
        ...renderCommandPairs([
            [`${COMMAND_PREFIX}start`, 'Inicia a recepção.'],
            [`${COMMAND_PREFIX}historia`, 'Mostra a história base do RPG.'],
            [`${COMMAND_PREFIX}sortear`, 'Faz um roll de criação.'],
            [`${COMMAND_PREFIX}rolls`, 'Mostra seus rolls.'],
            [`${COMMAND_PREFIX}sacrificar`, `Troca os ${MAX_PLAYER_ROLLS} rolls por um roll final.`],
            [`${COMMAND_PREFIX}ficha <número>`, 'Escolhe um roll e recebe a ficha.'],
            [`${COMMAND_PREFIX}magias`, 'Mostra ou escolhe magia.'],
            [`${COMMAND_PREFIX}familias`, 'Mostra famílias e vagas.'],
            [`${COMMAND_PREFIX}tracos`, 'Mostra aptidão, marca e anomalia.'],
            [`${COMMAND_PREFIX}aparencia Personagem - Obra`, 'Troca a aparência para avaliação.'],
            [`${COMMAND_PREFIX}continuar`, 'Mostra o próximo passo.'],
            [`${COMMAND_PREFIX}status`, 'Mostra sua fase atual.'],
            [`${COMMAND_PREFIX}ping`, 'Confirma que o bot está online.'],
        ]),
    ].join('\n');
}

function renderPreResetMenu(phase) {
    if (phase === PHASES.PRE_RESET_WAIT) {
        return [
            '♧┃𝐏𝐑𝐄_𝐑𝐄𝐒𝐄𝐓 · 𝐌𝐀𝐍𝐓𝐄𝐑',
            '',
            'Seu personagem está na lista de *MANTER*.',
            `Use *${COMMAND_PREFIX}status*, *${COMMAND_PREFIX}retorno* ou *${COMMAND_PREFIX}continuar* para consultar o estado.`,
        ].join('\n');
    }

    if (phase === PHASES.PRE_RESET_DECISION) {
        return [
            '♧┃𝐏𝐑𝐄_𝐑𝐄𝐒𝐄𝐓 · 𝐀𝐆𝐔𝐀𝐑𝐃𝐀𝐍𝐃𝐎',
            '',
            'Sua criação futura está bloqueada até a administração resolver a atribuição do cadastro.',
            `Use *${COMMAND_PREFIX}status* ou *${COMMAND_PREFIX}continuar*.`,
        ].join('\n');
    }

    return [
        '♧┃𝐏𝐑𝐄_𝐑𝐄𝐒𝐄𝐓 · 𝐂𝐑𝐈𝐀𝐂̧𝐀̃𝐎',
        '     ──  fluxo livre · personagem futuro  ──',
        '',
        ...renderCommandPairs([
            [`${COMMAND_PREFIX}sortear`, `Gera rolls da nova fase até ${MAX_PLAYER_ROLLS}.`],
            [`${COMMAND_PREFIX}rolls`, 'Mostra seus rolls futuros salvos.'],
            [`${COMMAND_PREFIX}magias`, 'Mostra magias, raridades, compatibilidade e vagas futuras reais.'],
            [`${COMMAND_PREFIX}magia <nome>`, 'Escolhe magia sem exigir Ficha antes; se houver mais de um roll compatível, o bot pergunta qual.'],
            [`${COMMAND_PREFIX}familias`, 'Mostra famílias, compatibilidade e vagas futuras reais.'],
            [`${COMMAND_PREFIX}tracos`, 'Mostra traços, tentativas usadas e vagas futuras de anomalias.'],
            [`${COMMAND_PREFIX}tentativa aptidao`, 'Gasta uma tentativa especial em Aptidão Rara.'],
            [`${COMMAND_PREFIX}tentativa marca`, 'Gasta uma tentativa especial em Marca Rara.'],
            [`${COMMAND_PREFIX}tentativa anomalia`, 'Gasta uma tentativa especial em Anomalia.'],
            [`${COMMAND_PREFIX}racas`, 'Mostra raças e vagas futuras reais.'],
            [`${COMMAND_PREFIX}grimorios`, 'Mostra grimórios, chances e vagas futuras reais.'],
            [`${COMMAND_PREFIX}classes`, 'Mostra as classes sociais.'],
            [`${COMMAND_PREFIX}reinos`, 'Mostra os reinos.'],
            [`${COMMAND_PREFIX}sacrificar`, `Depois dos ${MAX_PLAYER_ROLLS} rolls, permite trocá-los pelo roll final #${MAX_PLAYER_ROLLS + 1}.`],
            [`${COMMAND_PREFIX}ficha <número>`, 'Quando decidir um roll, recebe o modelo da Ficha Nova.'],
            [`${COMMAND_PREFIX}continuar`, 'Mostra opções úteis sem forçar uma ordem artificial.'],
            [`${COMMAND_PREFIX}status`, 'Mostra o estado real da criação futura.'],
        ]),
        '',
        `ⓘ Você pode consultar magia, família e traços antes de escolher o roll da ficha. Só a *Ficha Nova* fecha as escolhas.`,
    ].join('\n');
}

function renderStoryMenu(phase) {
    const title = phase === PHASES.HISTORIA_APROVADA
        ? 'HISTÓRIA APROVADA'
        : 'AGUARDANDO HISTÓRIA';

    return [
        `♧┃${title} 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫`,
        '     ──  história, persona ᥱ liberação  ──',
        '',
        '_`─( ✓ )───── 𝗘𝘀𝘁𝗮𝗱𝗼`_',
        '',
        'Sua ficha já passou pela recepção.',
        'A história e personalidade podem ser fechadas com calma.',
        '',
        '_`─( ■ )───── 𝗨𝘀𝗲`_',
        '',
        ...renderCommandPairs([
            [`${COMMAND_PREFIX}status`, 'Mostra o que falta.'],
            [`${COMMAND_PREFIX}continuar`, 'Explica a próxima etapa.'],
            [`${COMMAND_PREFIX}linkoff`, 'Reenvia no PV a mensagem de jogo liberado com o caminho do OFF.'],
            [`${COMMAND_PREFIX}ping`, 'Confirma que o bot está online.'],
        ]),
    ].join('\n');
}

function renderAppearanceMenu() {
    return [
        '♧┃𝐀𝐏𝐀𝐑𝐄̂𝐍𝐂𝐈𝐀 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫',
        '     ──  registro visual ᥱ avaliação  ──',
        '',
        '_`─( ✓ )───── 𝗘𝘀𝘁𝗮𝗱𝗼`_',
        '',
        'A ficha base já foi recebida.',
        'Agora falta enviar ou ajustar a aparência.',
        '',
        '_`─( ■ )───── 𝗨𝘀𝗲`_',
        '',
        ...renderCommandPairs([
            [`${COMMAND_PREFIX}aparencia Personagem - Obra`, 'Envia ou troca a aparência.'],
            [`${COMMAND_PREFIX}status`, 'Mostra o que falta.'],
            [`${COMMAND_PREFIX}continuar`, 'Explica a próxima etapa.'],
            [`${COMMAND_PREFIX}ping`, 'Confirma que o bot está online.'],
        ]),
    ].join('\n');
}

function renderAdminMenu() {
    return [
        '',
        '_`─( ! )───── 𝗔𝗗𝗠`_',
        '',
        ...renderCommandPairs([
            [`${COMMAND_PREFIX}setregistroclover`, 'Define o grupo de registro Clover.'],
            [`${COMMAND_PREFIX}registroclover`, 'Mostra o grupo de registro configurado.'],
            [`${COMMAND_PREFIX}setgrupooff`, 'Define o grupo OFF.'],
            [`${COMMAND_PREFIX}setgrupoon`, 'Define o grupo ON.'],
            [`${COMMAND_PREFIX}setgrupoarquivos`, 'Define o grupo de arquivos e sincroniza fichas.'],
            [`${COMMAND_PREFIX}setgrupoavisos`, 'Define o grupo de avisos da comunidade para detectar saídas.'],
            [`${COMMAND_PREFIX}setgrupoavaliacaofeitico`, 'Define o grupo de avaliação de feitiços e o link privado da fila.'],
            [`${COMMAND_PREFIX}recepcao ativar`, 'Ativa a mensagem de recepcao normal somente no grupo atual.'],
            [`${COMMAND_PREFIX}recepcao off ativar`, 'Ativa a mensagem de recepcao do grupo OFF no OFF configurado.'],
            [`${COMMAND_PREFIX}recepcao desativar`, 'Desativa a recepcao automatica do grupo atual.'],
            [`${COMMAND_PREFIX}setgrupoesquadrao <nome>`, 'Define o grupo atual como grupo de um esquadrão.'],
            [`${COMMAND_PREFIX}syncgrupoesquadrao`, 'Sincroniza a descrição do grupo do esquadrão.'],
            [`${COMMAND_PREFIX}revisaresquadroes`, 'Owner: revisa estrelas e sincroniza todos os grupos de esquadrão.'],
            [`${COMMAND_PREFIX}fraseesquadrao <frase>`, 'Define a frase do esquadrão na mensagem e descrição.'],
            [`${COMMAND_PREFIX}limparfraseesquadrao`, 'Remove a frase personalizada do esquadrão.'],
            [`${COMMAND_PREFIX}setcapitao <nome ou @player>`, 'Ajusta o capitão do esquadrão.'],
            [`${COMMAND_PREFIX}setvicecapitao @player`, 'Define o vice-capitão do esquadrão.'],
            [`${COMMAND_PREFIX}limparvicecapitao`, 'Remove o vice-capitão do esquadrão.'],
            [`${COMMAND_PREFIX}aparencias`, 'Lista aparências em uso e quem usa.'],
            [`${COMMAND_PREFIX}aprovaroff`, 'Aprova pedidos pendentes do OFF.'],
            [`${COMMAND_PREFIX}transmitirhistoria`, 'Transmite mensagem para história pendente.'],
            [`${COMMAND_PREFIX}transmitiraprovados`, 'Transmite mensagem para fichas aprovadas.'],
            [`${COMMAND_PREFIX}aprovarhistoria`, 'Aprova história/persona.'],
            [`${COMMAND_PREFIX}negarhistoria`, 'Marca história/persona para ajuste.'],
            [`${COMMAND_PREFIX}liberarjogo`, 'Libera comandos de jogo.'],
            [`${COMMAND_PREFIX}bloquearjogo`, 'Bloqueia comandos de jogo.'],
            [`${COMMAND_PREFIX}darph @player 20 motivo`, 'Adiciona PH ao jogador.'],
            [`${COMMAND_PREFIX}recompensa @A @B ph=40 motivo="Evento"`, 'Dá PH rapidamente para todos os players marcados.'],
            [`${COMMAND_PREFIX}tirarph @player 10 motivo`, 'Remove PH disponível sem reduzir acumulado.'],
            [`${COMMAND_PREFIX}ajustarph @player +20 motivo`, 'Faz ajuste administrativo de PH.'],
            [`${COMMAND_PREFIX}historicoph @player`, 'Mostra histórico de PH de um jogador.'],
            [`${COMMAND_PREFIX}sethexagono @player controle 2 motivo`, 'Ajusta o Hexágono de Mana de um player.'],
            [`${COMMAND_PREFIX}aprovarhexagono @player motivo`, 'Aprova um UP de Hexágono pendente.'],
            [`${COMMAND_PREFIX}capacidade técnica @player`, 'Mostra a leitura técnica completa de um player.'],
            [`${COMMAND_PREFIX}quem @player`, 'Diagnostica qual cadastro o bot encontrou para marcação, resposta, nome ou telefone.'],
            [`${COMMAND_PREFIX}vincular @player personagem="Nome"`, 'Corrige vínculo @lid/telefone/alias para o player_id certo.'],
            [`${COMMAND_PREFIX}ativarplayer @player motivo`, 'Owner: ativa manualmente um player canônico e reseta risco anti-ghost.'],
            [`${COMMAND_PREFIX}desativarplayer 1234 motivo`, 'Owner: desativa manualmente por marcação, resposta, telefone, nome ou últimos dígitos.'],
            [`${COMMAND_PREFIX}fila`, 'Lista a fila de avaliação de feitiços. Para player, mostra status.'],
            [`${COMMAND_PREFIX}proximo`, 'Chama o próximo, tenta adicionar no grupo, envia convite oficial e link.'],
            [`${COMMAND_PREFIX}concluir @player`, 'Conclui, remove do grupo, mantém o link atual e segue o fluxo.'],
            [`${COMMAND_PREFIX}pularfila @player motivo`, 'Pula a vez e devolve o player para o fim da fila.'],
            [`${COMMAND_PREFIX}removerfila @player motivo`, 'Remove/pula alguém da fila de avaliação.'],
            [`${COMMAND_PREFIX}resetfila`, 'Owner: cancela toda a fila de feitiços sem trocar o link.'],
            [`${COMMAND_PREFIX}fluxofeitico ligar`, 'Ativa o fluxo automático: concluiu, remove e chama o próximo.'],
            [`${COMMAND_PREFIX}fluxofeitico desligar`, 'Deixa a chamada do próximo manual.'],
            [`${COMMAND_PREFIX}aprovaravaliacaofeitico`, 'Aprova pedidos pendentes só de quem foi chamado.'],
            [`${COMMAND_PREFIX}feitico adicionar @player`, 'Adiciona feitiço aprovado usando a ficha na mesma mensagem.'],
            [`${COMMAND_PREFIX}addfeitico @player`, 'Atalho para adicionar feitiço aprovado.'],
            [`${COMMAND_PREFIX}feitico atualizar @player`, 'Salva uma nova versão do feitiço aprovado.'],
            [`${COMMAND_PREFIX}upfeitico @player`, 'Atalho para salvar nova versão de feitiço.'],
            [`${COMMAND_PREFIX}feitico remover @player Nome`, 'Remove feitiço salvo do grimório do player.'],
            [`${COMMAND_PREFIX}removerfeitico @player Nome`, 'Atalho para remover feitiço do grimório.'],
        ]),
    ].join('\n');
}

renderAdminMenu = function renderAdminMenuClean() {
    const section = (symbol, title) => `_` + '`' + `─( ${symbol} )───── ${title}` + '`' + `_`;

    return [
        '',
        section('!', '𝑨𝑫𝑴'),
        '',
        ...renderCommandPairs([
            [`${COMMAND_PREFIX}setregistroclover`, 'Define o grupo de registro Clover.'],
            [`${COMMAND_PREFIX}registroclover`, 'Mostra o grupo de registro configurado.'],
            [`${COMMAND_PREFIX}setgrupooff`, 'Define o grupo OFF.'],
            [`${COMMAND_PREFIX}setgrupoon`, 'Define o grupo ON.'],
            [`${COMMAND_PREFIX}setgrupoarquivos`, 'Define o grupo de arquivos e sincroniza fichas.'],
            [`${COMMAND_PREFIX}setgrupoavisos`, 'Define o grupo de avisos da comunidade para detectar saídas.'],
            [`${COMMAND_PREFIX}setgrupoavaliacaofeitico`, 'Define o grupo de avaliação de feitiços e o link privado da fila.'],
        ]),
        '',
        section('✦', '𝑹𝒆𝒄𝒆𝒑𝒄̧𝒂̃𝒐'),
        '',
        ...renderCommandPairs([
            [`${COMMAND_PREFIX}recepcao ativar`, 'Ativa a mensagem de recepção normal somente no grupo atual.'],
            [`${COMMAND_PREFIX}recepcao off ativar`, 'Ativa a mensagem de recepção do grupo OFF no OFF configurado.'],
            [`${COMMAND_PREFIX}recepcao desativar`, 'Desativa a recepção automática do grupo atual.'],
        ]),
        '',
        section('◆', '𝑬𝒔𝒒𝒖𝒂𝒅𝒓𝒐̃𝒆𝒔'),
        '',
        ...renderCommandPairs([
            [`${COMMAND_PREFIX}setgrupoesquadrao <nome>`, 'Define o grupo atual como grupo de um esquadrão.'],
            [`${COMMAND_PREFIX}syncgrupoesquadrao`, 'Sincroniza a descrição do grupo do esquadrão.'],
            [`${COMMAND_PREFIX}revisaresquadroes`, 'Owner: revisa estrelas e sincroniza todos os grupos de esquadrão.'],
            [`${COMMAND_PREFIX}fraseesquadrao <frase>`, 'Define a frase do esquadrão na mensagem e descrição.'],
            [`${COMMAND_PREFIX}limparfraseesquadrao`, 'Remove a frase personalizada do esquadrão.'],
            [`${COMMAND_PREFIX}setcapitao <nome ou @player>`, 'Ajusta o capitão do esquadrão.'],
            [`${COMMAND_PREFIX}setvicecapitao @player`, 'Define o vice-capitão do esquadrão.'],
            [`${COMMAND_PREFIX}limparvicecapitao`, 'Remove o vice-capitão do esquadrão.'],
        ]),
        '',
        section('◇', '𝑨𝒗𝒂𝒍𝒊𝒂𝒄̧𝒂̃𝒐'),
        '',
        ...renderCommandPairs([
            [`${COMMAND_PREFIX}aparencias`, 'Lista aparências em uso e quem usa.'],
            [`${COMMAND_PREFIX}aprovaroff`, 'Aprova pedidos pendentes do OFF.'],
            [`${COMMAND_PREFIX}transmitirhistoria`, 'Transmite mensagem para história pendente.'],
            [`${COMMAND_PREFIX}transmitiraprovados`, 'Transmite mensagem para fichas aprovadas.'],
            [`${COMMAND_PREFIX}aprovarhistoria`, 'Aprova história/persona.'],
            [`${COMMAND_PREFIX}negarhistoria`, 'Marca história/persona para ajuste.'],
            [`${COMMAND_PREFIX}liberarjogo`, 'Libera comandos de jogo.'],
            [`${COMMAND_PREFIX}bloquearjogo`, 'Bloqueia comandos de jogo.'],
        ]),
        '',
        section('⬡', '𝑹𝒆𝒄𝒖𝒓𝒔𝒐𝒔'),
        '',
        ...renderCommandPairs([
            [`${COMMAND_PREFIX}darph @player 20 motivo`, 'Adiciona PH ao jogador.'],
            [`${COMMAND_PREFIX}recompensa @A @B ph=40 motivo="Evento"`, 'Dá PH rapidamente para todos os players marcados.'],
            [`${COMMAND_PREFIX}tirarph @player 10 motivo`, 'Remove PH disponível sem reduzir acumulado.'],
            [`${COMMAND_PREFIX}ajustarph @player +20 motivo`, 'Faz ajuste administrativo de PH.'],
            [`${COMMAND_PREFIX}historicoph @player`, 'Mostra histórico de PH de um jogador.'],
            [`${COMMAND_PREFIX}servico semana`, 'Mostra o ranking semanal de PA dos avaliadores.'],
            [`${COMMAND_PREFIX}servico semanas @adm`, 'Mostra PA, teto e semanas pendentes de um avaliador.'],
            [`${COMMAND_PREFIX}servico pagar @adm`, 'Paga PA como PH dentro do teto semanal atual ou da semana informada.'],
            [`${COMMAND_PREFIX}servico pagar @adm 10 semana=2026-06-22`, 'Paga uma quantia específica de PA atrasado naquela semana.'],
            [`${COMMAND_PREFIX}servico pagar todos`, 'Paga PA pendente por semana, respeitando o teto de cada semana.'],
            [`${COMMAND_PREFIX}servico pagar todos semana=2026-06-22`, 'Tenta pagar todos os avaliadores pendentes em uma semana específica.'],
            [`${COMMAND_PREFIX}servico bonus @adm 5 motivo`, 'Adiciona PA manual para esforço extra.'],
            [`${COMMAND_PREFIX}servico sincronizar`, 'Importa avaliações antigas para PA sem duplicar.'],
            [`${COMMAND_PREFIX}checklist avisar`, 'Owner: enfileira avisos semanais faltantes para players liberados.'],
            [`${COMMAND_PREFIX}checklist reenviar`, 'Owner: cancela pendentes antigos e força uma nova leva semanal.'],
            [`${COMMAND_PREFIX}checklist envios`, 'Owner: audita avisos semanais enfileirados e entregas do MudaZap.'],
            [`${COMMAND_PREFIX}sethexagono @player controle 2 motivo`, 'Ajusta o Hexágono de Mana de um player.'],
            [`${COMMAND_PREFIX}aprovarhexagono @player motivo`, 'Aprova um UP de Hexágono pendente.'],
            [`${COMMAND_PREFIX}capacidade técnica @player`, 'Mostra a leitura técnica completa de um player.'],
            [`${COMMAND_PREFIX}quem @player`, 'Diagnostica qual cadastro o bot encontrou para marcação, resposta, nome ou telefone.'],
            [`${COMMAND_PREFIX}vincular @player personagem="Nome"`, 'Corrige vínculo @lid/telefone/alias para o player_id certo.'],
            [`${COMMAND_PREFIX}ativarplayer @player motivo`, 'Owner: ativa manualmente um player canônico e reseta risco anti-ghost.'],
            [`${COMMAND_PREFIX}desativarplayer 1234 motivo`, 'Owner: desativa manualmente por marcação, resposta, telefone, nome ou últimos dígitos.'],
        ]),
        '',
        section('⬡', '𝑬𝒗𝒆𝒏𝒕𝒐𝒔'),
        '',
        ...renderCommandPairs([
            [`${COMMAND_PREFIX}raid criar codigo=evento-01 nome="Nome" vagas=20 data=2026-06-24`, 'Cria uma raid/lobby de evento.'],
            [`${COMMAND_PREFIX}raid abrir evento-01`, 'Libera entrada de players na raid.'],
            [`${COMMAND_PREFIX}raid add evento-01 @player`, 'Adiciona participante manualmente.'],
            [`${COMMAND_PREFIX}raid remover evento-01 @player`, 'Remove participante da raid.'],
            [`${COMMAND_PREFIX}raid marcar evento-01 todos presente`, 'Marca participantes específicos ou todos.'],
            [`${COMMAND_PREFIX}raid recompensas evento-01`, 'Salva blocos de recompensa enviados na mesma mensagem.'],
            [`${COMMAND_PREFIX}raid simular evento-01`, 'Gera CloverScript e mostra o resumo antes de aplicar.'],
            [`${COMMAND_PREFIX}raid aplicar evento-01`, 'Aplica a simulação conferida da raid.'],
            [`${COMMAND_PREFIX}clover simular`, 'Simula ações administrativas em CloverScript.'],
            [`${COMMAND_PREFIX}clover aplicar codigo=CS-XXXXXX`, 'Aplica uma simulação CloverScript conferida.'],
        ]),
        '',
        section('!', '𝑨𝒏𝒕𝒊-𝑮𝒉𝒐𝒔𝒕'),
        '',
        ...renderCommandPairs([
            [`${COMMAND_PREFIX}antighost ativar`, 'Ativa o fluxo de atividade sem disparar PV em massa.'],
            [`${COMMAND_PREFIX}antighost desativar`, 'Pausa o fluxo anti-ghost.'],
            [`${COMMAND_PREFIX}antighost status`, 'Mostra configuração, candidatos e bônus ativos.'],
            [`${COMMAND_PREFIX}antighost sincronizarcomunidade`, 'Compara players liberados com o grupo de avisos/comunidade configurado.'],
            [`${COMMAND_PREFIX}antighost varrer`, 'Roda a checagem agora.'],
            [`${COMMAND_PREFIX}antighost avisar`, 'Reenvia avisos para candidatos atuais.'],
            [`${COMMAND_PREFIX}antighost envios`, 'Mostra auditoria recente de avisos, falhas, bônus e marcações de comunidade.'],
            [`${COMMAND_PREFIX}antighost candidatos`, 'Lista players em atenção, aviso e remoção.'],
            [`${COMMAND_PREFIX}antighost remover @player/1234 motivo`, 'Remove manualmente por inatividade, com alvo por marcação, resposta ou últimos dígitos.'],
            [`${COMMAND_PREFIX}antighost pular @player 30d motivo`, 'Dá exceção temporária para um player.'],
            [`${COMMAND_PREFIX}antighost resetar @player motivo`, 'Zera o risco e registra nova presença.'],
            [`${COMMAND_PREFIX}incentivo criar @player 10 72h motivo`, 'Cria bônus de retorno com prazo.'],
            [`${COMMAND_PREFIX}incentivo listar @player`, 'Lista bônus de retorno ativos ou recentes.'],
        ]),
        '',
        section('■', '𝑭𝒆𝒊𝒕𝒊𝒄̧𝒐𝒔'),
        '',
        ...renderCommandPairs([
            [`${COMMAND_PREFIX}fila`, 'Lista a fila de avaliação de feitiços. Para player, mostra status.'],
            [`${COMMAND_PREFIX}proximo`, 'Chama o próximo, tenta adicionar no grupo, envia convite oficial e link.'],
            [`${COMMAND_PREFIX}concluir @player`, 'Conclui, remove do grupo, mantém o link atual e segue o fluxo.'],
            [`${COMMAND_PREFIX}pularfila @player motivo`, 'Pula a vez e devolve o player para o fim da fila.'],
            [`${COMMAND_PREFIX}removerfila @player motivo`, 'Remove alguém da fila de avaliação.'],
            [`${COMMAND_PREFIX}resetfila`, 'Owner: cancela toda a fila de feitiços sem trocar o link.'],
            [`${COMMAND_PREFIX}fluxofeitico ligar`, 'Ativa o fluxo automático: concluiu, remove e chama o próximo.'],
            [`${COMMAND_PREFIX}fluxofeitico desligar`, 'Deixa a chamada do próximo manual.'],
            [`${COMMAND_PREFIX}aprovaravaliacaofeitico`, 'Aprova pedidos pendentes só de quem foi chamado.'],
            [`${COMMAND_PREFIX}feitico adicionar @player`, 'Adiciona feitiço aprovado usando a ficha na mesma mensagem.'],
            [`${COMMAND_PREFIX}addfeitico @player`, 'Atalho para adicionar feitiço aprovado.'],
            [`${COMMAND_PREFIX}feitico atualizar @player`, 'Salva uma nova versão do feitiço aprovado.'],
            [`${COMMAND_PREFIX}upfeitico @player`, 'Atalho para salvar nova versão de feitiço.'],
            [`${COMMAND_PREFIX}feitico remover @player Nome`, 'Remove feitiço salvo do grimório do player.'],
            [`${COMMAND_PREFIX}removerfeitico @player Nome`, 'Atalho para remover feitiço do grimório.'],
        ]),
        '',
        section('✓', 'Identidade'),
        '',
        ...renderCommandPairs([
            [`${COMMAND_PREFIX}lista criar copa-30`, 'Cria lista privada de alvos para recompensa.'],
            [`${COMMAND_PREFIX}lista add copa-30 tel=21975832436 personagem="Nome"`, 'Adiciona alvo e salva player_id canonico.'],
            [`${COMMAND_PREFIX}lista importar copa-30`, 'Importa varios alvos no formato Nome | telefone.'],
            [`${COMMAND_PREFIX}lista resolver copa-30`, 'Reconfere pendencias e identidades da lista.'],
            [`${COMMAND_PREFIX}recompensa lista=copa-30 ph=30 motivo="Evento"`, 'Simula recompensa por lista privada canonica.'],
            [`${COMMAND_PREFIX}recompensa aplicar codigo=CS-XXXXXX`, 'Aplica recompensa simulada e conferida.'],
            [`${COMMAND_PREFIX}mesclarplayer origem=... destino=... motivo="Cadastro espelho"`, 'Owner: mescla cadastro espelho no player canonico.'],
        ]),
    ].join('\n');
};

function renderEvaluatorMenu() {
    const section = (symbol, title) => `_` + '`' + `─( ${symbol} )───── ${title}` + '`' + `_`;

    return [
        '',
        section('★', 'Avaliador'),
        '',
        ...renderCommandPairs([
            [`${COMMAND_PREFIX}servico`, 'Mostra seus PA de avaliação pendentes e pagos.'],
            [`${COMMAND_PREFIX}servico semanas`, 'Mostra seus PA por semana, teto usado e quanto ainda cabe.'],
            [`${COMMAND_PREFIX}servico resgatar`, 'Usa PA pendente para completar o teto semanal atual.'],
            [`${COMMAND_PREFIX}servico resgatar 10`, 'Usa uma quantia específica de PA.'],
            [`${COMMAND_PREFIX}servico resgatar semana=2026-06-22`, 'Usa PA atrasado naquela semana, respeitando o teto dela.'],
            [`${COMMAND_PREFIX}servico historico`, 'Mostra seus registros recentes de serviço.'],
            [`${COMMAND_PREFIX}servico config`, 'Mostra pesos de cada tipo de avaliação.'],
        ]),
    ].join('\n');
}

function renderGameMenu() {
    return renderPostFichaHelp();
}

function renderMenuForPhase(phaseInfo) {
    if (phaseInfo.canPlay) return renderGameMenu();

    const { phase } = phaseInfo;
    if ([PHASES.PRE_RESET_BUILD, PHASES.PRE_RESET_WAIT, PHASES.PRE_RESET_DECISION].includes(phase)) {
        return renderPreResetMenu(phase);
    }
    if (phase === PHASES.HISTORIA_PENDENTE || phase === PHASES.HISTORIA_APROVADA) {
        return renderStoryMenu(phase);
    }
    if (phase === PHASES.APARENCIA_PENDENTE || phase === PHASES.APARENCIA_REJEITADA || phase === PHASES.APARENCIA_APROVADA) {
        return renderAppearanceMenu();
    }
    return renderReceptionMenu();
}

module.exports = {
    nome: `${COMMAND_PREFIX}ajuda`,
    descricao: 'Mostra os comandos principais conforme a fase.',
    executar: async ({ sock, m, idChat, idJogador, db }) => {
        const phaseInfo = await getPlayerPhase(db, idJogador);
        const owner = isOwner(idJogador);
        const evaluator = !owner && await canManagePlayer(sock, idChat, idJogador);
        const text = [
            renderMenuForPhase(phaseInfo),
            owner ? renderAdminMenu() : '',
            evaluator ? renderEvaluatorMenu() : '',
        ].filter(Boolean).join('\n');

        await sendReply({
            sock,
            idChat,
            m,
            text,
        });
    },
};
