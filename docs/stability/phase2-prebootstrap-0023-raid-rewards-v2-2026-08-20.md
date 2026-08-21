# FASE 2 — promoção pre-bootstrap 0023 Raid Rewards V2

Data: 20/08/2026

Base canônica: 9841cd7f64688288fda6ba1374aea42b25f33d67 (PR #280).

## Objetivo

Promover `0023_raid_rewards_v2` ao pre-bootstrap canônico para que bancos ainda não adotados cheguem ao shape Rewards V2 antes do bootstrap legacy, sem criar ledger e sem alterar `PRAGMA user_version`.

## Dependência base necessária

A migration 0023 é deliberadamente fail-closed quando `clover_raid_rewards` ou seu índice canônico estão ausentes. O catálogo base anterior possuía 18 tabelas e ainda não incluía Rewards.

Este slice adiciona `clover_raid_rewards` em shape V1 exato como a 19ª tabela-base e associa o índice `idx_clover_raid_rewards_raid(raid_id,status,id)` como SQL de criação inicial.

Regra crítica: o índice base é criado apenas quando o próprio catálogo acabou de criar a tabela. Se uma DB preexistente já possuir `clover_raid_rewards`, o catálogo não repara índice ausente/divergente nem shape incompatível. A 0023 continua responsável por bloquear esses estados explicitamente.

## Fluxo fresh DB

1. catálogo base cria 19 tabelas, incluindo Rewards V1;
2. cria o índice canônico da nova tabela Rewards;
3. pre-bootstrap executa 0002→0023 dentro do mesmo `BEGIN IMMEDIATE`;
4. 0023 converte V1→V2;
5. ledger continua ausente;
6. `user_version` continua 0;
7. legacy posterior encontra o V2 já pronto;
8. runtime Rewards ainda permanece como compatibilidade neste estágio.

## Preservação / fail-closed

- Rewards V1 existente + índice exato é convertido preservando IDs, rows, deliveries e `sqlite_sequence`;
- V2 exato continua no-op;
- V1 existente sem índice não é silenciosamente reparado pelo catálogo base e falha com `raid_rewards_v2_index_mapping_required`;
- shapes/dependências ambíguas continuam usando os gates fail-closed da formal 0023;
- nenhum reward/grant/delivery é aplicado ou reaplicado.

## Fronteira

Este PR promove somente base + pre-bootstrap + testes/documentação. Ele NÃO remove `ensureRaidRewardV2Schema`, NÃO remove o ensure de `resource_key`, NÃO altera Rewards service, Monthly, PA/PM/boxes, live DB/runtime, PM2, Mudzap, deploy ou reset.

Depois do merge: coverage proof 1:1 de Rewards runtime → cleanup do DDL runtime Rewards em slice separado.
