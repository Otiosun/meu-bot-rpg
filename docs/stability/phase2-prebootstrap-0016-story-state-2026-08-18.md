# FASE 2 — pre-bootstrap canônico até a migration 0016

Data: 18/08/2026

## Objetivo

Promover somente `0016_story_state_columns` para a allowlist transitória executada antes do legacy em bancos ainda não adotados.

`jogadores` já é tabela-base canônica. Não há mudança em `schemaBaseCatalog.js`.

## Mudança operacional

`DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS` passa de `0002→0015` para `0002→0016`.

O pre-bootstrap vazio passa a exigir:

- 15 tabelas-base;
- 15 migrations transitórias;
- os 8 campos de história presentes antes do legacy;
- ledger de migrations ausente;
- `PRAGMA user_version = 0`.

## Prova do delta 0016

Em schema descartável anterior sem os oito campos:

- 8/8 colunas são adicionadas;
- tipos/defaults coincidem com o legacy;
- segunda execução adiciona 0/8.

Em cópia do snapshot FASE 0:

- 623 jogadores antes/depois;
- 0 colunas adicionadas porque o schema já está completo;
- fingerprint de schema idêntico;
- digest lógico dos oito campos idêntico;
- `historia_status`: 599 `pendente`, 24 `aprovada`;
- 0 aprovadas sem `historia_aprovada_at` ou `historia_aprovada_by`;
- 0 não aprovadas carregando metadata de aprovação;
- 0 JSON inválido em `historias_extras`;
- `quick_check=ok`;
- `integrity_check=ok`;
- 0 violações de FK.

## Limites

- nenhum `UPDATE`, backfill, aprovação ou negação;
- nenhum writer/read-model de história/jogo alterado;
- nenhuma mudança em `schemaBaseCatalog.js`;
- nenhuma mudança em `database/legacy.js`;
- nenhum ensure removido neste PR.

Depois deste gate, os 8 ensures de história estarão seguros para cleanup somente depois que os blocos 0017 (jogo) e 0018 (`patente`) também forem formalizados e promovidos ao pre-bootstrap. O cleanup final de `jogadores` pode então ser feito em um único transporte mecânico de 13 linhas.

## Segurança

Nenhum banco Windows live, deploy, restart/reload, PM2, Mudzap, Raid ou Squads é tocado por este PR.
