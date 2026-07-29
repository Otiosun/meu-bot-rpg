# Pacote de revisao backend Clover

Este e o link principal para enviar a uma pessoa externa revisar o backend com
contexto suficiente e sem precisar reconstruir o historico recente.

## Estado atual

- Repositorio: `Otiosun/meu-bot-rpg`
- Branch principal: `main`
- Head organizado inicial: `76214dded6e9c494a52a79ce07b3e30fe83cb1f5`
- PR operacional de Times: #136, mesclada

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

## Times de Performance

Objetivo:
- manter `.#times`, `.#time` e `.#meutime` no bot;
- usar permissao administrativa por cargo real, nao numero fixo;
- manter a fase atual honesta: fila, confirmacao, cancelamento e lista
  administrativa.

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
- o problema original nao era falta de cargo;
- o comando `.#times` agora existe na `main`;
- a autorizacao por numero fixo foi removida;
- Edmund deve passar pelo cargo `admin` global mesmo quando o WhatsApp entregar
  `@lid`.

Para conferir:
1. garantir que o runtime esta na `main` atual;
2. reiniciar somente `clover-rpg`, se o bot ainda estiver com codigo antigo;
3. testar `.#times comandos` e `.#times admin` com Edmund.

Nao precisa:
- alterar cargo do Edmund de novo;
- mexer em banco vivo;
- mexer em MudZap, MudZap-ngrok ou WhatsApp;
- usar numero fixo como excecao.

## Pendencias reais

Ainda pendente:
- implementar a fase completa operacional dos Times;
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
