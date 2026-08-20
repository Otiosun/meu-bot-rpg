# FASE 2 — prova de cobertura participant finalization antes do cleanup runtime

Data: 20/08/2026

Base canônica: 717e1007dca9f269e643ab55c9a29beaa4011e90 (PR #277).

## Objetivo

Provar formalmente que os quatro `ensureColumn` de finalização ainda presentes em `raidRewardSchema.js` são redundância estrutural coberta pela migration 0022 e pelo pre-bootstrap canônico, sem removê-los neste slice.

## Cobertura esperada

- auditor global sobe de 152 para 156 targets;
- `basePresent` permanece 56;
- `baseMissing` sobe de 96 para 100, pois as quatro colunas não pertencem ao CREATE base do legacy;
- `legacyEnsurePresent` permanece 0;
- migration 0022 contribui exatamente 4 targets, todos em `clover_raid_participants`;
- runtime contém exatamente 4 ensures de participantes e suas definições espelham 1:1 os targets da 0022;
- `DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS` contém `0022_raid_participant_finalization`;
- índice `idx_clover_raid_participant_finalization` permanece presente;
- handoffs para reward V2, PA e character stat adjustment permanecem presentes;
- compatibilidade `eligible_legacy` permanece no serviço de finalização;
- estado pós-cleanup da 0021 continua válido.

## Fora de escopo

- remover os quatro ensures de finalização;
- alterar migration 0022;
- alterar pre-bootstrap;
- alterar `raidRewardSchema.js` ou `raidFinalizationService.js`;
- rewards V2, monthly progress, Inventory;
- live DB, runtime, PM2 ou Mudzap.

Se este gate fechar, o próximo slice pode remover exclusivamente os quatro ensures de `clover_raid_participants`, preservando índice e handoffs.
