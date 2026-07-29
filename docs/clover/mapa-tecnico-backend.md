# Mapa Tecnico Do Backend Clover RPG

Este documento e um mapa operacional curto para orientar manutencao e revisoes.
Ele descreve onde cada tipo de regra vive hoje, sem propor mudanca de
arquitetura imediata.

## Entrada Do Runtime

- `index.js`: inicia o bot WhatsApp, carrega comandos de `comandos/`, abre o
  banco via `criarBanco()` e sobe a API local quando usado pelo stack.
- `scripts/startCloverSiteStack.js`: wrapper PM2/runtime que inicia bot + API
  local + tunel configurado.
- `helpers/clover/siteApiServer.js`: rotas HTTP principais consumidas pelo site.
- `scripts/diagnoseCloverRuntime.js`: diagnostico local de PM2, porta, health e
  tunel.

## Banco

- `database.js`: fonte principal de schema e `criarBanco()`.
- `helpers/clover/databaseLifecycleGuard.js`: protecao de ciclo de vida das
  conexoes SQLite.
- `helpers/clover/sqliteBackupService.js`: backup SQLite consistente para
  instaladores e comandos operacionais.

Regra de operacao:
- script que toca banco vivo deve criar backup antes;
- schema novo deve ser idempotente;
- migracao real deve ter preview/auditoria quando houver risco de dados;
- nao criar seed em instalador de producao.

## Permissoes

- `helpers/groupAccess.js`: identidade do Owner fora do banco.
- `helpers/clover/accessControlService.js`: papeis e permissoes versionadas.
- `helpers/clover/accessRoleAssignmentService.js`: atribuicao/revogacao de
  papeis e sincronizacao de lideranca de esquadroes.
- `comandos/cargo.js`: comando administrativo para cargos.
- Contrato detalhado: `docs/clover/permissoes-backend.md`.
- Guia de revisao: `docs/clover/guia-revisao-backend.md`.
- Matriz de validacao: `docs/clover/matriz-validacao-backend.md`.
- Backlog operacional: `docs/clover/backlog-operacional.md`.
- Handoff externo: `docs/clover/handoff-revisao-externa.md`.
- Riscos tecnicos: `docs/clover/riscos-tecnicos-backend.md`.
- Comandos por permissao: `docs/clover/comandos-backend.md`.

Papeis atuais:
- Owner: reconhecido por `groupAccess`, acesso absoluto.
- `admin`: global, permissao `*`.
- `narrator`: leitura ampla e gestao narrativa/raid.
- `evaluator`: avaliacao e revisao de recompensa de raid.
- `captain`: escopo de esquadrao, gestao de membros e raids daquele escopo.
- `vice_captain`: leitura/apoio no escopo de esquadrao.

## Dominios Principais

### Personagem E Onboarding

- Comandos: `registrar.js`, `ficha.js`, `historia*.js`, `aparencia*.js`,
  `confirmarFicha.js`, `continuar.js`, `status.js`, `perfil.js`.
- Servicos: `helpers/playerRegistry.js`, `helpers/profileForms.js`,
  `helpers/onboardingFlow.js`, `helpers/clover/appearanceManager.js`,
  `helpers/clover/playerPhase.js`.

### Magia, Grimorio, Tracos E Arvores

- Comandos: `magia.js`, `grimorio.js`, `feitico.js`, `filaFeitico.js`,
  `fluxoFeitico.js`, `tracos.js`, `arvores.js`, `fisico.js`, `hexagono.js`.
- Servicos: `helpers/magicManager.js`, `helpers/clover/spell*`,
  `helpers/clover/*Trait*`, `helpers/rpg/arvores/*`.
- Contratos: `docs/clover/arvores/*`, `docs/spell-*.md`.

### Economia, Inventario E Posses

- Comandos: `saldo.js`, `ph.js`, `phAdmin.js`, `pr.js`, `comprar.js`,
  `lojas.js`, `mercado.js`, `inventario.js`, `abrircaixa.js`, `caixas.js`,
  `titulo.js`, `usar.js`, `resgatar.js`, `transferir.js`, `itemadm.js`.
- Servicos: `helpers/clover/economy*`, `helpers/clover/pa*`,
  `helpers/clover/market*`, `helpers/clover/customItems*`,
  `helpers/clover/possessions*`, `helpers/clover/box*`, `helpers/clover/title*`.
- Testes/scripts relevantes: `test:possessions-v1`, `test:box-pity`,
  `simulate:pa-*`.

### Esquadroes, QG, Capitaes E Estrelas

- Comandos: `esquadrao.js`, `estadoEsquadrao.js`, `qg.js`, `cargo.js`.
- Servicos: `helpers/clover/squad*`, `helpers/clover/captain*`,
  `helpers/clover/access*`.
- Scripts: `scripts/registerSquadCaptain.js`.
- Testes: `test:captain-personas`, `test:captains-season-stars`,
  `test:admin-team`.

### Raids E Finalizacao

- Comandos: `raid.js`.
- Servicos: `helpers/clover/raid*`, `helpers/clover/raidRewardProposalService.js`.
- Testes: `test:raid-progress`, `test:raid-finalization`.

### Mundos Dos Sonhos

- Servicos: `helpers/clover/dreamWorlds*`.
- Scripts: `install:dream-worlds`, `validate:dream-worlds`,
  `audit:dream-worlds`, `start:dream-worlds-preview-api`.
- Docs: `docs/mundos-dos-sonhos-*.md`.
- Testes: `test:dream-worlds`.

### Central ADM

- Comandos: `cloverAdminView.js`, `cloverScript.js`, `cloverApply.js`,
  `cloverSimulation.js`.
- Servicos: `helpers/clover/admin*`.
- Testes: `test:admin-core`, `test:admin-team`.

### Runtime, Tunel E Site

- Scripts: `start:site`, `diagnose:runtime`, `prepare:tunnel-rollback`,
  `prepare:production-release`.
- Servicos: `helpers/clover/site*`, `helpers/clover/*Http*`.
- Testes: `test:site-auth`, `test:site-stack`.

## Scripts De Manutencao

Padrao atual:
- `audit:*`: leitura e diagnostico.
- `plan:*`: plano sem aplicar.
- `preview:*`: simula aplicacao.
- `execute:*`: aplica alteracao controlada.
- `install:*`: instala schema/guards em banco real com backup.
- `simulate:*` e `check:*`: validacoes locais de contrato.

Regra para novos scripts:
- aceitar `--db` quando tocar banco;
- bloquear escrita sem flag explicita quando o alvo puder ser vivo;
- imprimir caminho de backup e resultado de auditoria;
- nao depender de PM2, WhatsApp ou tunel para testar logica.

## Estado De Times De Performance

No HEAD atual da `main`, nao ha modulo versionado de Times de Performance
(`comandos/times.js` ou `helpers/clover/performanceTeamService.js`).
Qualquer retomada desse sistema deve entrar como PR/branch propria e seguir o
padrao:

- comando fino em `comandos/times.js`;
- regras em `helpers/clover/performanceTeamService.js`;
- renderizacao separada, se crescer;
- permissoes via `accessControlService`;
- testes dedicados antes de publicar.

## Como Mexer Sem Baguncar

1. Comando deve parsear entrada, checar permissao e chamar service.
2. Service deve conter regra de produto, transacao e idempotencia.
3. Renderer/mensagem deve ficar separado quando a resposta for grande.
4. Script operacional deve usar backup e ser idempotente.
5. Teste deve cobrir a regra no service antes de depender do bot vivo.
6. Alteracao em banco vivo exige backup, integrity check e relatorio.
