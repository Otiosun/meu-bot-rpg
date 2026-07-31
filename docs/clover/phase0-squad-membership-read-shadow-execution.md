# P0 — Execução imutável do shadow de leitores de membros

## Objetivo

Executar o comparador da fonte legada `jogadores.esquadrao` contra `clover_squad_memberships` no snapshot da Fase 0, sem alterar o banco nem o enforcement atual.

## Pré-condições

1. snapshot consistente produzido pela PR #141;
2. auditoria de integridade da PR #154 executada e preservada;
3. branch do executor identificada por SHA;
4. relatório de saída em caminho privado ainda inexistente.

## Comando

```bash
AUDITOR_SHA="$(git rev-parse HEAD)"

node scripts/auditSquadMembershipReadShadow.js \
  --db=./backups/clover-phase0-producao.sqlite \
  --expected-auditor-sha="$AUDITOR_SHA" \
  --output=./backups/clover-phase0-membership-read-shadow.json \
  --fail-on-unsafe
```

## Garantias

- SQLite aberto com `OPEN_READONLY`;
- `PRAGMA query_only=ON` confirmado;
- SHA-256, tamanho e `mtime` comparados antes e depois;
- banco alterado durante a leitura causa falha;
- SHA inesperado do auditor bloqueia antes da abertura;
- resultado precisa declarar `write: false`, `queryOnlySafe: true` e `enforcementChanged: false`;
- evidência existente não é sobrescrita;
- relatório novo é gravado com permissão `0600`.

## Critério de avanço

A troca dos leitores permanece bloqueada enquanto qualquer condição abaixo for verdadeira:

- `criticalCount > 0`;
- `divergentPlayerCount > 0`;
- `changedSquadCount > 0`;
- `safeToSwitchConsumers !== true`.

`--fail-on-unsafe` retorna código 2 nessas situações. Isso representa um resultado de auditoria válido, não erro do executor.

## Limite

O comando não corrige vínculos, não cria tabelas e não altera respostas do bot, site ou Painel do Capitão.
