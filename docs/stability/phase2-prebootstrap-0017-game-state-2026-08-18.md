# FASE 2 — pre-bootstrap canônico até a migration 0017

Data: 18/08/2026

## Objetivo

Promover somente `0017_game_state_columns` para a allowlist transitória executada antes do legacy em bancos ainda não adotados.

`jogadores` já é tabela-base canônica; `schemaBaseCatalog.js` permanece inalterado.

## Mudança operacional

`DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS` passa de `0002→0016` para `0002→0017`.

O pre-bootstrap vazio passa a exigir:

- 15 tabelas-base;
- 16 migrations transitórias;
- 4/4 campos de estado de jogo presentes antes do legacy;
- ledger ausente;
- `PRAGMA user_version = 0`.

## Prova do delta

Em schema anterior sem os quatro campos:

- 4/4 colunas são adicionadas;
- tipos/defaults coincidem com o legacy;
- segunda execução adiciona 0/4.

Em cópia do snapshot FASE 0:

- 623 jogadores preservados;
- 0 colunas adicionadas porque o schema já está completo;
- fingerprint e digest dos quatro campos idênticos;
- estados permanecem 405 `bloqueado`, 138 `liberado`, 80 `arquivado`;
- 1 liberado com metadata incompleta permanece intocado;
- 78 não-liberados com metadata histórica de liberação permanecem intocados;
- `quick_check=ok`;
- `integrity_check=ok`;
- 0 violações de FK.

## Limites

- nenhum `UPDATE`, backfill ou reconciliação de estado;
- nenhum writer de história/jogo alterado;
- nenhuma mudança em schema-base ou legacy;
- nenhum ensure removido neste PR.

Depois deste gate resta apenas formalizar/promover `patente` (0018) antes do cleanup final dos 13 ensures de `jogadores`.

## Segurança

Nenhum banco Windows live, deploy, restart/reload, PM2, Mudzap, Raid ou Squads é tocado por este PR.
