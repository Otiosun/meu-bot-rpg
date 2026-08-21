# FASE 2 — promoção pre-bootstrap 0024 Raid Monthly Progress

Data: 21/08/2026

Base canônica: `6b76152e4e9f0603a81e7030061f960ed472af66` (PR #284).

## Objetivo
Promover `0024_raid_monthly_progress` ao pre-bootstrap canônico para que bancos
ainda não adotados cheguem ao shape Monthly formal antes do bootstrap legacy,
sem criar ledger de migrations e sem alterar `PRAGMA user_version`.

## Semântica
- catálogo base permanece com 19 tabelas;
- pre-bootstrap passa de 22 para 23 migrations transitórias (`0002→0024`);
- Monthly ausente é criado vazio pela própria migration 0024;
- Monthly exato permanece no-op;
- estado parcial/incompatível continua fail-closed;
- nenhuma Raid histórica gera reserva ou crédito Monthly retroativo;
- ledger de migrations continua ausente e `user_version` continua 0.

## Fronteira
Não remove `ensureRaidMonthlyProgressSchema()`, não altera DDL runtime Monthly,
não muda a migration 0024 formal, não muda o auditor 156/56/100/0 e não toca
live DB/runtime, PM2, Mudzap, deploy ou reset.

Depois do merge: coverage proof Monthly -> cleanup runtime Monthly -> auditoria global Raid.
