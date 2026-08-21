# FASE 2 — cleanup runtime 0023 Raid Rewards V2

Data: 20/08/2026

Base canônica: efb7513402286d3e23ea851bd3717e420fd9f7d2 (PR #282).

## Objetivo

Remover do runtime o rebuild/DDL redundante de Rewards V2 agora coberto pela migration formal 0023, pre-bootstrap 0023 e coverage proof dedicado.

## Removido de `ensureRaidRewardV2Schema`

- inspeção textual de tipos PA/PM/box;
- SAVEPOINT `migrate_clover_raid_rewards_v2`;
- rename para `clover_raid_rewards_legacy_v1`;
- CREATE TABLE V2;
- cópia V1→V2;
- DROP da tabela temporária;
- CREATE INDEX `idx_clover_raid_rewards_raid`;
- ensure de `resource_key`.

O wrapper permanece:

```js
async function ensureRaidRewardV2Schema(db) {
    await ensureCloverRaidSchema(db);
}
```

## Ajuste de auditor legado

O gate pós-cleanup da finalização 0022 ainda representava o estado intermediário anterior à 0023: zero ensures de participantes, mas exatamente um ensure Rewards/resource_key. Depois da formalização + pre-bootstrap + coverage 0023, essa premissa ficou obsoleta.

Este slice atualiza o gate finalization pós-cleanup para exigir:
- zero ensures de participantes;
- zero chamadas runtime de `ensureColumn` em `raidRewardSchema.js`;
- índice/handoffs/política de finalização preservados;
- helper/export genérico `ensureColumn` preservado por compatibilidade.

Reintroduzir ensure Rewards após este cleanup passa a falhar fechado.

## Preservado

- chamada de `ensureRaidRewardV2Schema(db)` por `ensureRaidFinalizationSchema`;
- export público `ensureRaidRewardV2Schema`;
- `ensureColumn` e `tableColumns` + exports, por cautela de compatibilidade;
- migration formal 0023;
- pre-bootstrap 0023;
- coverage audit dedicado;
- auditor de colunas 156/56/100/0.

Nenhum reward, delivery, banco live, runtime live, PM2, Mudzap ou deploy é tocado.
