# FASE 2 — promoção da 0019 de Squads ao pre-bootstrap

Data: 19/08/2026

## Objetivo

Promover `0019_squad_columns` para `DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS` somente depois da integração da migration 0019 no catálogo formal.

## Contrato

O pre-bootstrap canônico passa de `0002→0018` para `0002→0019`.

A 0019 continua sendo DDL idempotente puro:

- adiciona somente as 8 colunas versionadas de `clover_squads` quando ausentes;
- não executa `UPDATE` nem backfill;
- não altera membros ou estrelas;
- não cria nem altera ledger de migrations durante o pre-bootstrap;
- não altera `PRAGMA user_version` durante o pre-bootstrap;
- não toca Raid.

## Prova de schema legado

O teste dedicado cria uma `clover_squads` no formato antigo, contendo somente:

- `squad_key`;
- `name`;
- `historical_stars`;
- `current_stars`;
- `black_stars`;
- `updated_at`.

Ele grava dados reais de fixture, executa o pre-bootstrap canônico e exige:

- as 8 colunas da 0019 presentes ao final;
- nome, estrelas e timestamp preservados exatamente;
- novas colunas com `NULL` quando não havia valor legado;
- ausência do ledger `clover_schema_migrations`;
- `PRAGMA user_version = 0`.

## Fronteira de remoção

Este PR **não remove** os 8 `ensureColumn()` de Squads do `database/legacy.js`.

A remoção só pode ocorrer em PR mecânico separado depois desta promoção ser testada e integrada. O único `ensureColumn()` de Raid permanece congelado e fora do escopo.
