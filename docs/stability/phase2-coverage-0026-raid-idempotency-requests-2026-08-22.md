# Fase 2 — Coverage 0026 — Raid idempotency requests

Data: 2026-08-22

Base canônica: `d87e1f332332c009bd0954d059ec9d86ea21ef32`.

## Objetivo

Provar, antes do cleanup, que os dois wrappers runtime da family A têm ownership
formal 1:1 em `0026_raid_idempotency_requests` e no pre-bootstrap canônico.

## Evidências congeladas

- `ensureRaidCreationIdempotencySchema()`: uma tabela
  `clover_raid_creation_requests` e um índice
  `idx_clover_raid_creation_status` exatos;
- `ensureRaidClaimedMutationSchema()`: uma tabela
  `clover_raid_mutation_requests` e um índice
  `idx_clover_raid_mutation_requests_status` exatos;
- os dois wrappers, exports e um callsite operacional em cada `prepare*` permanecem
  presentes antes do cleanup;
- formal 0026 contém gates fail-closed de schema, índice e estado armazenado;
- 0026 não lê histórico de Raid nem executa DML retroativo, replay, receipt,
  reward ou backfill;
- pre-bootstrap real possui 25 chaves, termina em 0026, cria 19 tabelas base e
  entrega as duas tabelas e dois índices exatos, vazios, sem ledger e com
  `user_version=0`;
- cleanup sintético troca somente os corpos dos dois wrappers por no-op, preserva
  exports/callsites e confirma que o schema continua vindo exclusivamente do
  pre-bootstrap;
- fontes runtime, migration, pre-bootstrap e legacy permanecem intocadas.

## Fronteira

Este slice adiciona apenas coverage proof. Nenhum wrapper é limpo nesta etapa.

Próximo fluxo:

coverage 0026 → cleanup dos 2 wrappers DDL → family B proposal/authors/revisions.