# FASE 2 — cleanup runtime dos oito ensureColumn de Raid V2

Data: 19/08/2026

Base canônica: 421afa20de4e0e75cb3c141a054cf3aa2be1a0c4 (PR #274).

## Objetivo

Remover exclusivamente a redundância DDL dos oito ensureColumn de clover_raids em raidV2Schema.js, agora que a migration 0021 está formalizada, promovida ao pre-bootstrap e coberta pelo auditor.

## Removido

- import ensureColumn de raidRewardSchema;
- category_key;
- category_label;
- scope_type;
- scope_player_id;
- scope_squad_key;
- month_key;
- counts_monthly;
- monthly_limit.

## Preservado

- ensureCloverRaidSchema e ensureCloverSquadSchema;
- idx_clover_raids_monthly_scope;
- normalização de legado sem category_key;
- alias missao_desenvolvimento → saga_pessoal;
- normalização global para evento_especial;
- ensureRaidFinalizationSchema;
- ensureRaidMonthlyProgressSchema;
- tableColumns exportado;
- migration 0021, pre-bootstrap, legacy e schemaBaseCatalog.

## Gates

- pre-removal: 8/8 ensures reconhecidos pelo gate do PR #274;
- pós-cleanup: 0 ensureColumn/0 token ensureColumn em raidV2Schema.js;
- auditor global permanece 152/56/96/0;
- 8 targets V2 continuam na 0021;
- pre-bootstrap continua terminando em 0021;
- dependências runtime V2 continuam 100% presentes;
- suíte focada permanece verde.

## Fora de escopo

- finalização;
- rewards;
- monthly reservations/ledger;
- live DB, PM2 e Mudzap.
