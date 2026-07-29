# Pacote de revisao backend Clover

Este e o link principal para enviar a uma pessoa externa revisar o backend com
contexto suficiente e sem precisar reconstruir o historico recente.

## Estado atual

- Repositorio: `Otiosun/meu-bot-rpg`
- Branch principal: `main`
- Head organizado: `76214dded6e9c494a52a79ce07b3e30fe83cb1f5`
- PR operacional de Times: #136
- Branch da PR de Times: `feature/performance-teams-bot-v1`
- Estado da PR #136: draft

## O que ja foi organizado

Documentos de entrada:
- `docs/clover/README.md`
- `docs/clover/mapa-tecnico-backend.md`
- `docs/clover/guia-revisao-backend.md`
- `docs/clover/handoff-revisao-externa.md`

Contratos e validacao:
- `docs/clover/permissoes-backend.md`
- `docs/clover/matriz-validacao-backend.md`
- `docs/clover/comandos-backend.md`
- `scripts/check-access-permissions-contract.js`

Operacao e risco:
- `docs/clover/backlog-operacional.md`
- `docs/clover/riscos-tecnicos-backend.md`
- `docs/clover/runbook-banco-vivo.md`
- `docs/clover/runbook-operacional-site.md`
- `docs/clover/runbook-publicacao-final.md`

## Como revisar

1. Comecar por `docs/clover/README.md`.
2. Ler `docs/clover/handoff-revisao-externa.md`.
3. Conferir o dominio da PR em `docs/clover/mapa-tecnico-backend.md`.
4. Escolher testes em `docs/clover/matriz-validacao-backend.md`.
5. Conferir riscos em `docs/clover/riscos-tecnicos-backend.md`.

## PR #136: Times de Performance

Objetivo:
- restaurar `.#times`, `.#time` e `.#meutime` no bot;
- manter o trabalho em PR propria;
- corrigir a permissao administrativa para usar cargo real, nao numero fixo.

Arquivos principais:
- `comandos/times.js`
- `helpers/clover/performanceTeamService.js`
- `tests/performanceTeamService.test.js`
- `helpers/clover/accessIntegrationService.js`

Validacao ja registrada na PR:
- `npm run test:performance-teams`
- `npm run check:access-permissions`
- `npm run test:admin-team`
- `npm run test:site-stack`
- `npm run test:captains-season-stars`
- `npm run test:site-auth`
- `git diff --check`

## Caso Edmund

Diagnostico:
- Edmund ja possui personagem ativo e jogo liberado no banco vivo;
- Edmund ja possui cargo `admin` global ativo;
- o problema nao e falta de cargo;
- o problema e que a `main` atual ainda nao contem o comando `.#times`;
- o trabalho arquivado antigo dos Times usava numero fixo, o que quebra com
  identidade `@lid`.

Correcao preparada:
- PR #136 remove a autorizacao por numero fixo;
- PR #136 usa Owner ou `admin` global pelo contrato oficial;
- assim Edmund passa a gerir Times por cargo real.

Para resolver de vez:
1. revisar e aprovar a PR #136;
2. tirar a PR do draft;
3. mesclar na `main`;
4. atualizar o runtime local para a nova `main`;
5. reiniciar somente `clover-rpg`;
6. testar `.#times comandos` e `.#times admin` com Edmund.

Nao precisa:
- alterar cargo do Edmund de novo;
- mexer em banco vivo;
- mexer em MudZap, MudZap-ngrok ou WhatsApp;
- usar numero fixo como excecao.

## Pendencias reais

Ainda pendente:
- revisar/mesclar PR #136 para ativar Times no bot vivo;
- documentar ou implementar a fase completa operacional dos Times;
- depois criar frontend/site dos Times, se ainda fizer sentido;
- consolidar auditorias legadas de dados;
- Named Tunnel/dominio continua backlog futuro, nao bloqueante.

## Comandos uteis para revisao

Estado:

```powershell
git status --short --branch
git fetch origin
git rev-parse HEAD
git rev-parse origin/main
```

Permissoes:

```powershell
npm run check:access-permissions
npm run test:admin-team
```

Times:

```powershell
npm run test:performance-teams
```

Site/API:

```powershell
npm run test:site-auth
npm run test:site-stack
```

Sempre:

```powershell
git diff --check
```

## Limites para revisao externa

Nao enviar nem tocar:
- `banco.sqlite`;
- backups reais;
- `.env`;
- tokens;
- QR code;
- arquivos de sessao WhatsApp;
- logs com dados privados;
- numeros completos de players.

Nao executar sem autorizacao:
- scripts com `--apply`;
- migrations em banco vivo;
- restart de PM2;
- deploy;
- merge de PR.
