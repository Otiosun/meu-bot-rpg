# Comandos backend por permissao

Este documento resume os comandos operacionais do bot por camada de acesso. Ele
serve como mapa de revisao; a fonte final continua sendo o codigo em `comandos/`
e os services chamados por cada comando.

Prefixo padrao: `.#`

## Leitura publica ou do proprio player

Normalmente qualquer player pode usar, com leitura limitada ao proprio cadastro
quando houver dados privados.

- `.#perfil` - ficha publica/propria; leitura de terceiros usa contrato de
  personagem.
- `.#capacidade` - capacidade propria; visao tecnica exige permissao.
- `.#grimorio` - grimorio proprio; visao tecnica exige permissao.
- `.#feitico` - ver/gerir fluxo proprio de feiticos; adicionar/remover no bot
  exige moderacao.
- `.#inventario` - inventario proprio.
- `.#saldo` - saldos proprios.
- `.#extrato` - historico proprio.
- `.#caixas` / `.#abrircaixa` - consulta e abertura de caixas proprias.
- `.#titulo` - consulta/ativacao de titulo proprio.
- `.#usar` / `.#resgatar` - uso ou resgate de item proprio quando permitido.
- `.#comprar`, `.#lojas`, `.#mercado`, `.#vender`, `.#transferir` - economia de
  player, com regras internas de saldo, estoque, ator e idempotencia.
- `.#site` - link/acesso ao site.
- `.#status`, `.#continuar` - progresso de onboarding.
- `.#familias`, `.#racas`, `.#reinos`, `.#classes`, `.#grimorios`,
  `.#magia`, `.#arvores`, `.#fisico`, `.#tracos` - consulta de regras e
  catalogos.

## Owner

Owner nao e cargo de banco. E reconhecido por `helpers/groupAccess.js`.

Comandos exclusivos ou praticamente exclusivos:

- `.#cargo` / `.#permissao` - concede, revoga, lista e audita cargos
  sistemicos.
- `.#cloverview` - visoes administrativas completas.
- `.#diagnosticarbanco` - integridade completa do banco.
- `.#reset` - reset manual de player.
- `.#playercontrole` - ativa/desativa player manualmente.
- `.#mesclarplayer` - mescla cadastros.
- `.#mensagem` - altera mensagens operacionais persistidas.
- `.#entregas` - consulta entregas auxiliares.
- `.#statusjogador` / `.#estadoplayer` - ciclo de vida completo.
- `.#transmitirhistoria` / `.#transmitiraprovados` - disparos em massa.
- `.#checklist` auditoria/disparo semanal - acoes sensiveis do checklist.
- `.#servico` acoes administrativas amplas de PA/avaliadores.
- `.#cloverscript` acoes `TODOS` e operacoes sensiveis internas.
- `.#cloverapply` - aplicacao de CloverScript.

Services internos tambem reservam Owner para:
- desfazer CloverScript;
- reset/undo de reset;
- arquivar/reativar player;
- remover membro via CloverScript;
- aplicar Anti-Ghost destrutivo;
- alterar equipe ADM pela Central ADM.

## Cargo `admin`

Cargo global versionado em `clover_access_roles`, com permissao `*`.

Pode operar sistemas administrativos cobertos pelo contrato novo:

- Central ADM e rotas administrativas do site, respeitando capacidades internas.
- Leitura administrativa de personagens.
- Gestao de QG/esquadrao quando o service aceita permissao global.
- Revisao de recompensas quando a permissao integrada cobre o fluxo.
- Times de Performance quando a PR #136 for mesclada:
  `performance_team.manage`.

Importante:
- `admin` nao substitui Owner onde o codigo exige Owner explicitamente.
- Se um comando ainda usa "ADM do grupo ou Owner", ele esta em regra legada e
  deve ser revisado antes de virar base de sistema novo.

## Cargo `narrator`

Cargo global para operacao narrativa.

Permissoes principais:
- leitura ampla de personagem;
- leitura de estado/membros/recursos de esquadrao;
- criar e gerenciar raids;
- ler todas as raids.

Comandos/areas relacionadas:
- `.#raid` - criacao/gestao quando passa pelos services de Raid V2/legado;
- consultas de esquadrao/estado quando usam `squad.read.*`;
- modelos de item em alguns fluxos administrativos junto com `admin`.

## Cargo `evaluator`

Cargo global para avaliacao.

Permissoes principais:
- leitura de perfil/progresso/capacidade/grimorio;
- visao tecnica de capacidade e grimorio;
- `evaluation.apply`;
- `raid.reward.review`.

Comandos/areas relacionadas:
- avaliacao rapida e aplicacao de ficha;
- leitura tecnica em `.#capacidade` e `.#grimorio`;
- fila/revisao de recompensa de Raid por proposta pendente valida.

Limite importante:
- avaliador nao deve concluir Raid normal como host;
- avaliador nao deve aprovar a propria proposta;
- entrega por avaliador deve passar pelo fluxo de proposta.

## Cargo `captain`

Cargo escopado a esquadrao.

Permissoes principais:
- leitura de personagem no escopo aplicavel;
- leitura de estado, membros e recursos do proprio esquadrao;
- gerir membros do proprio esquadrao;
- criar/gerenciar raids do proprio esquadrao;
- comprar/gerir benfeitorias de QG do proprio esquadrao.

Comandos/areas relacionadas:
- `.#qg`;
- `.#estadoesquadrao`;
- `.#esquadrao` quando a acao estiver no escopo;
- `.#raid` para o proprio esquadrao.

## Cargo `vice_captain`

Cargo escopado a esquadrao.

Permissoes principais:
- leitura de personagem no escopo aplicavel;
- leitura de estado, membros e recursos do proprio esquadrao;
- gerir benfeitorias de QG por permissao integrada.

Limite atual:
- nao gerencia membros na V1;
- nao recebe permissao V1 para criar Raid fora do contrato definido.

## Regra legada: ADM do grupo ou Owner

Alguns comandos ainda usam administracao do grupo WhatsApp como autorizador.
Isso funciona operacionalmente, mas nao deve ser copiado para sistemas novos.

Exemplos:
- `.#bonus` - ver bonus de outro player.
- `.#aprovarhexagono`, `.#sethexagono`, `.#hexagono` - administracao/consulta de
  Hexagono de terceiros.
- `.#registroclover` - definir registro Clover.
- `.#historiajogo` - gerenciar historia/jogo.
- `.#gruposclover` - configurar grupos ON/OFF/Arquivos.
- `.#esquadrao` - algumas acoes de gestao.
- `.#pr`, `.#phadmin` - ajustes administrativos historicos.
- `.#filaadmin`, `.#filafeitico`, `.#fluxofeitico` - filas operacionais.
- `.#recompensa`, `.#lista`, `.#incentivo`, `.#antighost`,
  `.#antighostsafe` - manutencoes operacionais.
- `.#cloverscript`, `.#cloversimulation`, `.#cloverapply` - entrada externa
  ainda aceita ADM de grupo para parte do fluxo, mas services internos reservam
  acoes sensiveis ao Owner.

Diretriz:
- quando um desses comandos for alterado, avaliar migracao para
  `accessControlService`;
- nao ampliar escopo de ADM de grupo;
- adicionar teste de permissao antes de mudar comportamento.

## Comandos com escrita sensivel em banco

Exigem cuidado especial em revisao:

- `.#cargo` - altera cargos versionados e auditoria.
- `.#cloverscript` / `.#cloverapply` - opera multiplos dominios.
- `.#reset`, `.#playercontrole`, `.#mesclarplayer` - ciclo de vida/identidade.
- `.#phadmin`, `.#pr`, `.#bonus`, `.#recompensa` - economia/recompensas.
- `.#abrircaixa`, `.#usar`, `.#resgatar`, `.#comprar`, `.#mercado` - inventario
  e saldos.
- `.#raid` - progresso, participantes e recompensas.
- `.#qg`, `.#esquadrao` - esquadroes, membros e recursos.
- `.#filaadmin`, `.#filafeitico`, `.#grupoavaliacaofeitico` - filas e chamadas.
- `.#mensagem`, `.#recepcaogrupo`, `.#gruposclover` - configuracao persistida.

Padrao esperado:
- idempotencia onde houver retry ou clique duplo;
- transacao quando houver leitura seguida de escrita critica;
- teste de regressao para bug comprovado;
- backup antes de operacao real em banco vivo, quando for script operacional.

## Times de Performance

Estado atual:
- `main` ainda nao contem o comando;
- PR #136 restaura `.#times`, `.#time` e `.#meutime` em draft.

Contrato pretendido:
- `.#times`, `.#times comandos`, `.#times participar`, `.#meutime`: publico
  para player elegivel;
- controles administrativos: Owner ou `admin` global por
  `performance_team.manage`;
- nao usar numero fixo de Edmund;
- reconhecer ator por identidade canonica/cargo real.

## Como manter este documento

Ao criar ou alterar comando:

1. Atualize a secao de permissao afetada.
2. Atualize `docs/clover/permissoes-backend.md` se houver permissao nova.
3. Atualize `scripts/check-access-permissions-contract.js` se o contrato mudar.
4. Adicione teste de permissao no dominio do comando.
5. Rode a suite indicada em `docs/clover/matriz-validacao-backend.md`.
