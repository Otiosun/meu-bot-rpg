# FASE 2 — migration 0009 Admin Service

Data: 17/08/2026

## Escopo

`0009_admin_service_columns` versiona 13 colunas de `clover_admin_service_entries`:

- `target_player_id` — `TEXT DEFAULT NULL`;
- `evaluation_id` — `INTEGER DEFAULT NULL`;
- `paid_points` — `INTEGER NOT NULL DEFAULT 0`;
- `status` — `TEXT NOT NULL DEFAULT 'pending'`;
- `service_week_key` — `TEXT DEFAULT NULL`;
- `scene_week_key` — `TEXT DEFAULT NULL`;
- `scene_sent_at` — `TEXT DEFAULT NULL`;
- `evaluated_at` — `TEXT DEFAULT NULL`;
- `created_by` — `TEXT DEFAULT NULL`;
- `voided_at` — `TEXT DEFAULT NULL`;
- `voided_by` — `TEXT DEFAULT NULL`;
- `reason` — `TEXT DEFAULT NULL`;
- `metadata_json` — `TEXT DEFAULT NULL`.

Checksum esperado da migration canônica:
`d9b5ecc46dc044c3c560eb0d9e383ad38e3e11f19b32b51325a78b51f89a8b99`.

## Schema-base e ordem de bootstrap

As 13 colunas já existem no `CREATE TABLE IF NOT EXISTS clover_admin_service_entries` do `database/legacy.js` canônico. Os três índices dependentes continuam depois dos `ensureColumn()` legados:

- `idx_clover_admin_service_evaluation`;
- `idx_clover_admin_service_evaluator_status`;
- `idx_clover_admin_service_week`.

A `0009` **não entra na allowlist transitória do pre-bootstrap canônico** nesta etapa. O contrato permanece:

1. banco ainda não adotado executa transitoriamente apenas 0002→0008;
2. `database/legacy.js` cria/repara Admin Service;
3. `runCloverSchemaMigrations` formaliza 0001→0009 depois do legacy;
4. banco já adotado em v8 possui a tabela e pode aplicar 0009 antes do legacy pelo fluxo normal de migrations pendentes.

Isso preserva o desenho deliberado do PR #231: migrations futuras não entram automaticamente no pre-bootstrap.

## Gate isolado

A lógica da 0009 foi exercitada em SQLite descartável:

- tabela antiga sem as 13 colunas → adiciona exatamente as 13;
- tabela já completa → schema-no-op;
- tabela ausente dentro de transação → falha e rollback;
- checksumMaterial contém 13 targets;
- `up()` não executa `UPDATE`.

Gate isolado: **3/3 PASS**.

## Snapshot real da FASE 0

Cópia descartável de `banco-fase0.sqlite`, nunca o original.

Estado observado:

- `clover_admin_service_entries`: 427 registros;
- as 13 colunas já existem com tipos/defaults esperados;
- os três índices dependentes existem;
- schema hash antes/depois da aplicação equivalente da 0009: `a6a6140f9e689a7cd839840c1e9b54f8ed0575e27a332ba7711103ee92dd64fc`;
- 427 registros antes e depois;
- `quick_check=ok`;
- `integrity_check=ok`;
- `foreign_key_check=0`.

Logo, no snapshot real a 0009 é adoção formal sem mutação de domínio/dados.

## Regressões versionadas

- `databaseMigration0008.test.js` fica explicitamente congelado em migrations até v8;
- `databaseMigration0009.test.js` cobre v9, no-op, rollback/precondition e checksum;
- `databaseMigrationCatalog.test.js` exige catálogo formal até v9;
- `schemaBasePrebootstrap.test.js` mantém fixture custom em v8, mas exige v9 nos boots com legacy real; a fixture de rollback passa a usar versão 10 para continuar testando rollback real.

## Segurança

- nenhum `database/legacy.js` alterado neste PR;
- nenhuma remoção dos 13 `ensureColumn()` ainda;
- nenhuma mudança em `schemaBaseCatalog.js` ou na allowlist 0002→0008;
- nenhum banco Windows live aberto/escrito;
- nenhum deploy/restart/reload;
- PM2/Mudzap intocados;
- Raid/Squads não reabertos.
