# FASE 2 — migration 0008 Inventory Items

Data: 17/08/2026

## Escopo

`0008_inventory_item_columns` versiona 17 colunas de `clover_inventory_items`: `template_key`, `catalog_version`, `category`, `origin`, `status`, `quality`, `base_price`, `reference_price`, `durability_current`, `durability_max`, `bound`, `transferable`, `equipped_slot`, `expires_at`, `updated_at`, `properties_json` e `effects_json`.

Checksum: `f4772ce1fefa5611455c7711fc3a4d3e24dcad7bbc32370907901cac4035ea5a`.

O `CREATE TABLE` legado termina antes dessas colunas; índices posteriores dependem de `template_key/status` e `equipped_slot`. O bootstrap legado também executa normalizações de dados depois dos ensures. A 0008 **não contém UPDATE** e não tenta mover essa normalização: adota somente o DDL das colunas.

## Gate local

Suíte focada: **46/46 PASS**.

- 0008 adiciona exatamente 17 colunas e segunda execução é no-op;
- schema já completo é no-op estrutural;
- tabela ausente preserva ledger/user_version em 0007;
- checksumMaterial cobre os 17 targets;
- contrato prova que `migration.up` não contém UPDATE;
- testes históricos da 0007 ficam fixados até v7;
- catálogo explícito exige v8.

## Snapshot real

Cópia descartável do snapshot FASE 0, SHA `45952a05fd9aee1518bb6e575029681f405fd55e4df9981fadbcb78c3a0f1ed6`.

Antes: user_version 0, 169 tabelas, 471.430 linhas, `clover_inventory_items` com 680 registros, fingerprint `39050767cc8bae6d864b6c59bbf4d7a552ea892ee26e8529c4f43966eee979a1`, quick/integrity OK, 0 FK violations.

Após 0001→0008: user_version 8, ledger `[1,2,3,4,5,6,7,8]`, 169 tabelas/471.430 linhas, 0 contagens alteradas, fingerprint idêntico, quick/integrity OK, 0 FK violations, segunda execução no-op.

## Segurança

- nenhum `database.js`, `database/legacy.js` ou `schemaMigrationService.js` alterado;
- nenhum UPDATE/mutação de dados nesta migration;
- nenhum deploy/restart/live DB/PM2/Mudzap;
- nenhuma reabertura funcional de Raid/Hooks/Squads.
