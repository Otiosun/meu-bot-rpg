# Fase 2 — Migration 0025 — Raid support tables

Data: 2026-08-21

## Motivo

A auditoria global de Raid encontrou seis tabelas auxiliares ainda criadas exclusivamente pelo `database/legacy.js`, apesar de 0020–0024 já cobrirem bridge V1, V2, finalização, Rewards V2 e Monthly:

- `clover_raid_hosts`
- `clover_raid_loadout_items`
- `clover_raid_item_events`
- `clover_raid_conditions`
- `clover_raid_reward_deliveries`
- `clover_raid_events`

Isso bloqueia o fechamento honesto da Campanha A: o bootstrap canônico ainda depende do legacy para criar esse bloco.

## Contrato da 0025

`0025_raid_support_tables` formaliza exatamente as seis tabelas acima e seus seis índices canônicos:

- `idx_clover_raid_hosts_active`
- `idx_clover_raid_loadout_participant`
- `idx_clover_raid_item_events_raid`
- `idx_clover_raid_conditions_raid`
- `idx_clover_raid_reward_deliveries_player`
- `idx_clover_raid_events_raid`

Política fail-closed:

1. ausência total das seis tabelas + ausência dos nomes de índices canônicos → cria o shape exato vazio;
2. seis tabelas com shape e índices exatos → no-op, preservando rows, SQL e sequences;
3. conjunto parcial → recusa;
4. table-shape incompatível → recusa;
5. índice canônico ausente/divergente/homônimo em outro objeto → recusa;
6. estado armazenado fora dos domínios CHECK conhecidos → recusa;
7. índices extras não canônicos são preservados;
8. nenhum backfill, conversão retroativa ou síntese de histórico.

## Limites desta slice

Esta slice **não** promove 0025 ao pre-bootstrap e **não** remove o DDL de Raid de `database/legacy.js`.
O fluxo continua separado:

formal 0025 → pre-bootstrap 0025 → coverage proof → cleanup do DDL legacy → repetir auditoria global Raid.

Também não altera DB live, runtime operacional, PM2 ou Mudzap.
