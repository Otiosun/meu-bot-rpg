# FASE 2 — pre-bootstrap canônico até a migration 0015

Data: 18/08/2026

## Objetivo

Promover somente `0015_roll_attempt_state_columns` para a allowlist transitória executada antes do legacy em bancos ainda não adotados.

`jogadores` já é tabela-base canônica; `schemaBaseCatalog.js` permanece inalterado.

## Mudança operacional

`DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS` passa de `0002→0014` para `0002→0015`.

O pre-bootstrap vazio passa a exigir:

- 15 tabelas-base;
- 14 migrations transitórias;
- `tentativas_especiais`, `roll_sacrifice_used` e `roll_sacrifice_used_at` presentes antes do legacy;
- ledger de migrations ausente;
- `PRAGMA user_version = 0`.

## Prova do delta 0015

Em schema anterior sem os três campos:

- 3/3 colunas são adicionadas;
- segunda execução adiciona 0/3;
- tipos/defaults coincidem com o legacy.

Em cópia do snapshot real:

- 623 jogadores antes/depois;
- 0 colunas adicionadas porque o schema já está completo;
- fingerprint e digest dos três campos idênticos;
- 209 estados de tentativas não-vazios preservados;
- 57 jogadores com sacrifício usado e os mesmos 57 com timestamp;
- 0 inconsistências used/timestamp;
- 0 JSON inválido;
- quick/integrity OK;
- 0 violações FK.

## Limites

- nenhum reset, consumo, UPDATE ou backfill;
- nenhuma mudança em `schemaBaseCatalog.js`;
- nenhuma mudança em `database/legacy.js`;
- nenhum ensure removido neste PR;
- Raid e Squads continuam fora do escopo.

Depois deste gate, os 10 ensures da 0014 e os 3 da 0015 podem ser removidos juntos em um único cleanup mecânico de 13 linhas.

## Segurança

Nenhum banco Windows live, deploy, restart/reload, PM2 ou Mudzap é tocado por este PR.
