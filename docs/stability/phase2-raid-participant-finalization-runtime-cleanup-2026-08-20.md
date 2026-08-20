# FASE 2 — cleanup runtime participant finalization 0022

Data: 20/08/2026

Base canônica: 0722f3a46075d1d99977f8e2d0834fa5bb051781 (PR #278).

## Objetivo

Remover exclusivamente os quatro `ensureColumn` de `clover_raid_participants` em `ensureRaidFinalizationSchema`, agora que a migration 0022 está formalizada, promovida ao pre-bootstrap e coberta 1:1 pelo auditor.

## Removido

- `finalization_status`;
- `finalization_note`;
- `finalized_by`;
- `finalized_at`.

## Preservado obrigatoriamente

- helper `ensureColumn`;
- ensure de `clover_raid_rewards.resource_key` em `ensureRaidRewardV2Schema`;
- `ensureCloverRaidSchema(db)`;
- índice `idx_clover_raid_participant_finalization(raid_id, finalization_status, status, id)`;
- `ensureRaidRewardV2Schema(db)`;
- `ensurePaSchema(db)`;
- `ensureCharacterStatAdjustmentSchema(db)`;
- compatibilidade `eligible_legacy`;
- migration 0022 e pre-bootstrap 0022;
- estado pós-cleanup da 0021.

## Gates

- auditor global permanece 156/56/100/0;
- 4 targets da 0022 permanecem formais;
- runtime finalization passa de 4 → 0 ensures de participantes;
- chamada restante de `ensureColumn` no arquivo deve ser exatamente `clover_raid_rewards.resource_key TEXT DEFAULT NULL`;
- dependências finalization permanecem 6/6;
- pre-removal sintético continua provando 4/4;
- reintrodução de qualquer ensure de participante falha fechado;
- remoção do ensure de Rewards/resource_key falha fechado;
- suíte Raid V2 com pre-bootstrap real permanece verde;
- live/DB/PM2/Mudzap intocados.

## Fora de escopo

- formalizar/rebuild de rewards V2 (0023);
- monthly progress (0024);
- bug basal Inventory/template_key;
- alteração de dados;
- deploy/runtime live.
