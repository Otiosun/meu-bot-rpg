# FASE 2 — cleanup dos 13 ensureColumn de Admin Service

Data: 17/08/2026

## Pré-condições fechadas

- migrations 0002→0008 + cleanup dos 53 ensures anteriores já estão no main;
- migration `0009_admin_service_columns` foi mergeada no PR #234;
- pre-bootstrap canônico foi estendido até a 0009 no PR #235;
- `clover_admin_service_entries` é a 14ª tabela-base canônica;
- as 13 colunas de Admin Service existem no CREATE base e na migration 0009.

## Escopo

Remover exatamente 13 chamadas `await ensureColumn(...)` de `clover_admin_service_entries`:

- target_player_id;
- evaluation_id;
- paid_points;
- status;
- service_week_key;
- scene_week_key;
- scene_sent_at;
- evaluated_at;
- created_by;
- voided_at;
- voided_by;
- reason;
- metadata_json.

Legacy canônico antes do cleanup:
`970e6375699f2e9ee20483994844852b1df2d95f`.

Legacy candidato após as 13 deleções:
`3d22dc4e654c8ccf7e3f7ebf0eba72d33a4191ea`.

Diff mecânico esperado:

- 0 adições;
- 13 deleções;
- 59 chamadas `ensureColumn()` não migradas permanecem.

Nenhum índice, seed, normalização ou CREATE TABLE é removido.

## Auditor pós-cleanup

`schemaBaseConsolidationAudit` passa a cobrir migrations 0002→0009:

- totalTargets = 66;
- basePresent = 28;
- baseMissing = 38;
- legacyEnsurePresent = 0.

Dependências pós-DDL sobem para 11, incluindo:

- `idx_clover_admin_service_evaluation`;
- `idx_clover_admin_service_evaluator_status`;
- `idx_clover_admin_service_week`.

`legacyEnsureColumnCleanup.test.js` exige 59 ensures ainda não migrados e impede reintrodução de qualquer um dos 66 já cobertos.

## Prova dinâmica original × cleaned

O legacy atual pós-cleanup dos 53 (`970e637...`) e o candidato sem os 13 Admin (`3d22dc4...`) foram executados em arquivos SQLite separados.

### Banco pré-bootstrapped até a 0009

- 68 tabelas em ambos;
- schema fingerprint idêntico: `6d50d8307fd3ac8ed53022cd06e51a8aefa05363bcdc171672af71676f3fd9e2`;
- contagens idênticas;
- Admin Service idêntico;
- quick_check=ok;
- integrity_check=ok;
- 0 violações FK.

### Snapshot real FASE 0

- 169 tabelas em ambos;
- 471.430 linhas em ambos;
- schema fingerprint idêntico: `39050767cc8bae6d864b6c59bbf4d7a552ea892ee26e8529c4f43966eee979a1`;
- 0 mudanças de contagem;
- `clover_admin_service_entries`: 427 registros em ambos;
- digest lógico dos 427 registros idêntico: `38c51e6b74b79717ca356c9fb18ff76257b05c2edb5cd86457ed166f6fa7a82d`;
- quick_check=ok;
- integrity_check=ok;
- 0 violações FK.

## Segurança

- nenhum banco Windows live foi aberto/escrito;
- nenhum deploy/restart/reload;
- PM2/Mudzap intocados;
- Raid/Squads não reabertos;
- cleanup estritamente mecânico e limitado às 13 linhas já cobertas por migration + pre-bootstrap.
