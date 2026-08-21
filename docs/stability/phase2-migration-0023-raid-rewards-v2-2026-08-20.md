# FASE 2 — migration 0023 Raid Rewards V2

Data: 20/08/2026

Base canônica: 0270eef08f8d35b6e772e037baa5c138fa0dc655 (PR #279).

## Objetivo

Formalizar o rebuild estrutural de `clover_raid_rewards` que hoje ainda acontece no runtime por `ensureRaidRewardV2Schema`, sem aplicar, reaplicar, entregar ou cancelar qualquer recompensa.

## Shape V1 reconhecido

- `reward_type`: `yulls | ph | stars | catalog_item`;
- `amount > 0`;
- sem `resource_key`;
- índice canônico `idx_clover_raid_rewards_raid(raid_id,status,id)`.

Somente o V1 exato entra no caminho de rebuild.

## Shape V2 canônico

- `reward_type`: `yulls | ph | stars | catalog_item | pa | pm | box`;
- PM aceita valor positivo ou negativo, mas nunca zero;
- demais rewards exigem `amount > 0`;
- `resource_key TEXT DEFAULT NULL`;
- demais colunas preservadas;
- índice canônico `idx_clover_raid_rewards_raid(raid_id,status,id)`.

## Política fail-closed

- V1 exato -> rebuild dentro da transação `BEGIN IMMEDIATE` do migrator formal;
- V2 exato -> no-op real;
- shape parcial/ambíguo -> `raid_rewards_v2_schema_mapping_required`;
- índice ausente/divergente -> `raid_rewards_v2_index_mapping_required`;
- índice/trigger/view/FK de entrada inesperado -> `raid_rewards_v2_dependency_mapping_required`;
- estado V1 incompatível -> `raid_rewards_v2_state_mapping_required`;
- divergência durante cópia -> `raid_rewards_v2_copy_validation_failed`.

## Preservação

O rebuild:
- copia IDs explicitamente;
- preserva todos os campos V1;
- inicializa `resource_key` como `NULL`;
- compara V1 e V2 com `EXCEPT` antes de apagar a tabela temporária;
- preserva a `sqlite_sequence` histórica, inclusive quando ela está acima do maior ID;
- não toca em `clover_raid_reward_deliveries`;
- não toca em proposals;
- não cria nem altera progresso mensal;
- não executa serviço de reward;
- não reaplica grants.

## Fronteira deste slice

A 0023 entra somente no catálogo formal. Ela NÃO é promovida ao pre-bootstrap neste mesmo PR e o DDL runtime de Rewards permanece presente até um slice separado de promoção/cobertura/cleanup.

Live DB, runtime live, PM2, Mudzap, deploy e reset permanecem fora de escopo.
