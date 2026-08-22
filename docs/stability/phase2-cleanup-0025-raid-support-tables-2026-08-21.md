# Fase 2 — Cleanup 0025 — Raid support tables

Data: 2026-08-21

Base canônica: `8c08dc3b5fb01233089e013ad929ea6603d3d2e7`.

## Objetivo

Remover de `database/legacy.js::ensureCloverRaidSchema()` somente o ownership DDL das
seis tabelas auxiliares e seis índices canônicos já formalizados por
`0025_raid_support_tables` e promovidos ao pre-bootstrap.

## Pré-condições já provadas

- coverage 0025: 55/55 PASS;
- 6/6 CREATE TABLE legacy equivalentes ao formal 0025;
- 6/6 CREATE INDEX legacy equivalentes ao formal 0025;
- pre-bootstrap com 24 migrations, latest `0025_raid_support_tables`;
- cleanup sintético remove exatamente 12 blocos DDL;
- migration 0025 permanece fail-closed e não retroativa;
- auditor de colunas permanece 156/56/100/0.

## Cleanup

O slice altera apenas:

- `database/legacy.js`: remove os 12 blocos DDL auxiliares 0025;
- `tests/raidSupportCoverageAudit.test.js`: converte a prova para o estado
  pós-cleanup;
- este documento.

`ensureCloverRaidSchema()` continua existindo e exportado. O ownership core de Raid
(`clover_raids`, `clover_raid_participants` e índices core), chamadas operacionais e
demais schema legacy permanecem.

## Gate pós-cleanup

O legacy limpo deve executar depois do pre-bootstrap real sem recriar ownership
auxiliar. As seis tabelas auxiliares devem continuar exatas, indexadas e vazias em
DB descartável. Reintrodução futura de qualquer DDL auxiliar 0025 deve falhar fechado.

Próximo fluxo:

cleanup 0025 → auditoria global Raid final → fechamento da Campanha A.
