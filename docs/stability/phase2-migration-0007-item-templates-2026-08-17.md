# FASE 2 — migration 0007 Item Templates

Data: 17/08/2026

## Escopo

`0007_item_template_columns` versiona sete colunas de `clover_item_templates`:
- `is_custom` — `INTEGER NOT NULL DEFAULT 0`;
- `requestable` — `INTEGER NOT NULL DEFAULT 0`;
- `marketable` — `INTEGER NOT NULL DEFAULT 1`;
- `duplicable` — `INTEGER NOT NULL DEFAULT 1`;
- `created_by` — `TEXT DEFAULT 'system'`;
- `updated_by` — `TEXT DEFAULT NULL`;
- `archived_at` — `TEXT DEFAULT NULL`.

Checksum: `a4145760aade0ef93258e20bc589131dcf2a43c44cc627d62369aa816860205a`.

Nenhuma das sete está no `CREATE TABLE` legado atual; o índice `idx_clover_item_templates_requestable` usa `requestable` imediatamente após os `ensureColumn()`. Portanto este PR versiona a responsabilidade, mas não remove o DDL legado.

## Gate local

Suíte focada: **42/42 PASS**.

- 0007 adiciona exatamente sete colunas e segunda execução é no-op;
- schema já completo é no-op estrutural;
- tabela ausente preserva ledger/user_version em 0006;
- checksumMaterial cobre os sete targets;
- testes históricos da 0006 ficam fixados até v6;
- catálogo explícito exige v7.

## Snapshot real

Cópia descartável do snapshot FASE 0, SHA `45952a05fd9aee1518bb6e575029681f405fd55e4df9981fadbcb78c3a0f1ed6`.

Antes: user_version 0, 169 tabelas, 471.430 linhas, `clover_item_templates` com 87 registros, fingerprint `39050767cc8bae6d864b6c59bbf4d7a552ea892ee26e8529c4f43966eee979a1`, quick/integrity OK, 0 FK violations.

Após 0001→0007: user_version 7, ledger `[1,2,3,4,5,6,7]`, 169 tabelas/471.430 linhas, 0 contagens alteradas, fingerprint idêntico, quick/integrity OK, 0 FK violations, segunda execução no-op.

## Segurança

- nenhum `database.js`, `database/legacy.js` ou `schemaMigrationService.js` alterado;
- nenhum deploy/restart/live DB/PM2/Mudzap;
- nenhuma mudança de dados de jogador;
- nenhuma reabertura funcional de Raid/Hooks/Squads.
