# FASE 2 — pre-bootstrap canônico até a migration 0014

Data: 18/08/2026

## Objetivo

Promover somente `0014_character_trait_columns` para a allowlist transitória executada antes do legacy em bancos ainda não adotados.

`jogadores` já é uma das 15 tabelas-base canônicas, portanto `schemaBaseCatalog.js` não precisa mudar.

## Mudança operacional

`DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS` passa de `0002→0013` para `0002→0014`.

O pre-bootstrap vazio passa a exigir:

- 15 tabelas-base;
- 13 migrations transitórias;
- as 10 colunas de traços presentes antes do legacy;
- ledger de migrations ausente;
- `PRAGMA user_version = 0`.

## Prova do delta 0014

Em schema anterior com `jogadores` sem as dez colunas:

- 10/10 colunas são adicionadas;
- segunda execução adiciona 0/10;
- tipos/defaults coincidem com o legacy.

Em cópia do snapshot real:

- 623 jogadores antes/depois;
- 0 colunas adicionadas porque o schema já está completo;
- fingerprint de schema idêntico;
- digest das dez colunas idêntico;
- `quick_check=ok`;
- `integrity_check=ok`;
- 0 violações FK.

A anomalia textual preexistente sem `anomalia_key` permanece inalterada. Este gate não executa normalização ou backfill.

## Limites

- nenhuma mudança em `schemaBaseCatalog.js`;
- nenhuma mudança em `database/legacy.js`;
- nenhum `ensureColumn()` removido ainda;
- nenhum `UPDATE` ou backfill;
- nenhum writer de perfil/traços alterado;
- Raid e Squads continuam fora do escopo.

Depois deste gate, os dez `ensureColumn()` equivalentes da 0014 podem ser submetidos ao cleanup mecânico com prova original×cleaned e auditor pós-DDL.

## Segurança

Nenhum banco Windows live, deploy, restart, reload, PM2 ou Mudzap é tocado por este PR.
