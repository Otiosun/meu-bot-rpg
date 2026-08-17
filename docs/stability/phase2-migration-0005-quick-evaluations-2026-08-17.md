# FASE 2 — migration 0005 Quick Evaluations

Data: 17/08/2026

## Escopo

`0005_quick_evaluation_columns` versiona seis colunas do schema legado de avaliações rápidas:
- `quoted_message_key` — `TEXT DEFAULT NULL`;
- `scene_sent_at` — `TEXT DEFAULT NULL`;
- `scene_source` — `TEXT DEFAULT NULL`;
- `evaluated_at` — `TEXT DEFAULT NULL`;
- `salary_eligible` — `INTEGER DEFAULT NULL`;
- `salary_service_type` — `TEXT DEFAULT NULL`.

Checksum:
`26e651f18483a8edffd3ff84062cdadb73f327963dc478aa69d421a2171fce49`

A migration é adicionada somente ao catálogo modular `schemaMigrationCatalog.js`; o motor `schemaMigrationService.js` permanece inalterado.

## Observação sobre o schema-base

O `CREATE TABLE` legado já contém os quatro campos de cena (`quoted_message_key`, `scene_sent_at`, `scene_source`, `evaluated_at`). Os dois campos salariais ainda dependem dos `ensureColumn()` legados em instalação nova. Portanto este PR **não remove** nenhuma dessas chamadas. A futura limpeza consolidada deverá primeiro tornar o schema-base autocontido para os dois campos salariais.

## Gate local

Suíte focada da FASE 2: **33/33 PASS**.

Cobertura específica:
- 0005 cria exatamente os seis targets e segunda execução é no-op;
- cenário de transição com quatro campos de cena já existentes adiciona somente os dois campos salariais;
- tabela `clover_quick_evaluations` ausente falha fechado e preserva ledger/user_version em 0004;
- checksumMaterial cobre os seis targets;
- testes da 0004 são explicitamente fixados em migrations até a versão 4;
- catálogo atual/fixtures continuam cobertos.

## Snapshot real

Cópia descartável de `/mnt/data/banco-fase0.sqlite`.

SHA-256 original e cópia antes da prova:
`45952a05fd9aee1518bb6e575029681f405fd55e4df9981fadbcb78c3a0f1ed6`

Antes:
- `user_version=0`;
- 169 tabelas de domínio;
- 471.430 linhas agregadas;
- fingerprint `39050767cc8bae6d864b6c59bbf4d7a552ea892ee26e8529c4f43966eee979a1`;
- quick/integrity OK;
- 0 violações FK.

Após 0001→0005:
- `user_version=5`;
- ledger `[1,2,3,4,5]`;
- 169 tabelas / 471.430 linhas preservadas;
- **0 contagens alteradas**;
- fingerprint exatamente idêntico;
- quick/integrity OK;
- 0 violações FK;
- `schemaFingerprintMatchesLatest=true`;
- segunda execução `appliedCount=0`.

## Segurança

- nenhum `database/legacy.js` alterado;
- nenhum `schemaMigrationService.js` alterado;
- nenhum deploy/restart/live DB/PM2/Mudzap;
- nenhuma mudança de dados de jogador;
- nenhuma reabertura funcional de Raid/Hooks/Squads.
