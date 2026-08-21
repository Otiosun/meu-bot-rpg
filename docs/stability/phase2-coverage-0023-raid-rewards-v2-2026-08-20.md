# FASE 2 — coverage proof 0023 Raid Rewards V2

Data: 20/08/2026

Base canônica: e8e7fff43cbabe407ce6254eb415e59f5228e531 (PR #281).

## Objetivo

Provar, antes do cleanup runtime, que o DDL/rebuild ainda existente em `ensureRaidRewardV2Schema` está coberto pelo contrato formal + pre-bootstrap da migration `0023_raid_rewards_v2`.

A 0023 é uma migration de table-shape/constraints. Por isso este proof NÃO adiciona falsos “targets de coluna” ao auditor 156/56/100/0.

## Cobertura exigida

O gate dedicado compara:
- `CREATE TABLE clover_raid_rewards` runtime contra `RAID_REWARDS_V2_TABLE_SQL`;
- índice runtime contra `RAID_REWARDS_V2_INDEX`;
- projeção de cópia V1→V2 runtime contra a própria função `RAID_REWARDS_V2_MIGRATION.up`;
- ensure runtime `resource_key TEXT DEFAULT NULL`;
- presença de `0023_raid_rewards_v2` no pre-bootstrap;
- handoff `ensureCloverRaidSchema`, chamada por `ensureRaidFinalizationSchema` e export público;
- garantias formais mais fortes da 0023: preservação de `sqlite_sequence`, fail-closed de dependências/shape e cópia ordenada.

## Política

- runtime Rewards permanece INTACTO neste slice;
- auditor de colunas permanece exatamente 156/56/100/0;
- o teste também sintetiza o estado pós-cleanup esperado: `ensureRaidRewardV2Schema` mantém apenas `await ensureCloverRaidSchema(db);`, com handoff/export preservados;
- reintrodução de DDL/ensure depois do cleanup deve falhar fechado.

## Próximo slice

Após merge deste proof, remover o rebuild/DDL/ensure `resource_key` do runtime Rewards em commit separado. Só então seguir para 0024 Monthly.

Live DB/runtime, PM2, Mudzap, deploy, rewards e deliveries reais permanecem fora de escopo.
