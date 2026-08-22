# Fase 2 — Coverage 0025 — Raid support tables

Data: 2026-08-21

Base canônica: `bcbf47d303d3bfb60492cd539cdd06b4315ee097`.

## Objetivo

Provar, antes de qualquer cleanup real, que o bloco auxiliar Raid ainda presente em
`database/legacy.js::ensureCloverRaidSchema()` já possui owner canônico completo em
`0025_raid_support_tables` e no pre-bootstrap.

## Prova exigida

- exatamente seis tabelas auxiliares formalizadas e seis índices canônicos;
- cada `CREATE TABLE` do legacy compara 1:1 com o SQL formal 0025;
- cada `CREATE INDEX` do legacy compara 1:1 com o SQL formal 0025;
- `0025_raid_support_tables` está no pre-bootstrap canônico (24 migrations transitórias);
- migration mantém fail-closed de schema, índices e estado armazenado;
- migration não lê Raid/participantes históricos e não executa DML retroativo;
- cleanup sintético remove exatamente os 12 blocos DDL auxiliares e preserva
  `ensureCloverRaidSchema`, seu export e ownership core de Raid;
- módulo legacy sinteticamente limpo continua executável depois do pre-bootstrap real,
  com as seis tabelas auxiliares exatas e vazias;
- auditor de colunas permanece 156/56/100/0.

## Fronteira

Esta slice é somente coverage proof. `database/legacy.js` não é alterado.
O cleanup real é um slice posterior, condicionado ao PASS deste gate.

Próximo fluxo:

coverage 0025 → cleanup DDL auxiliar Raid no legacy → auditoria global Raid final.
