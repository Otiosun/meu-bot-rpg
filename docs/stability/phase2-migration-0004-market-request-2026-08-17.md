# FASE 2 — migration 0004 e catálogo modular

Data: 17/08/2026

## Objetivo

Versionar um terceiro lote pequeno de DDL legado sem tocar no Windows live e reduzir a necessidade de regravar o motor de migrations a cada novo lote.

## Arquitetura

`schemaMigrationService.js` permanece byte a byte igual ao `main` após a 0003 e continua sendo o motor transacional/checksum/fingerprint.

Novo `helpers/clover/schemaMigrationCatalog.js` passa a ser o catálogo atual para o caminho real de `database.js`. Ele agrega as migrations core já mergeadas (0001–0003) e a 0004. Assim, migrations futuras podem ser adicionadas modularmente sem editar repetidamente o motor de ~17 KB.

`database.js` resolve o catálogo assim:
- legacy real/default -> catálogo atual;
- fixture/custom legacy -> catálogo core por padrão, preservando compatibilidade histórica;
- testes/callers podem fornecer `options.migrations` explicitamente para reproduzir o catálogo atual.

O comportamento `custom_legacy_without_opener` continua baseline-only.

## Migration 0004

`0004_market_request_columns`:
- `clover_market_listings.idempotency_key` — `TEXT DEFAULT NULL`;
- `clover_weekly_npc_requests.required_quality` — `TEXT NOT NULL DEFAULT 'qualquer'`;
- `clover_weekly_npc_requests.required_condition` — `TEXT NOT NULL DEFAULT 'qualquer'`.

Checksum:

`669721ef1c7d99d84215564691e262fe9b786ecd0cc85578dc174f0b5d5e363e`

Os checksums 0001/0002/0003 permanecem exatamente os já versionados.

O índice parcial único `idx_clover_market_listings_idempotency` já existe no schema legado/snapshot; ele não é recriado nem movido neste lote. A 0004 adota apenas as três colunas.

## Gate local

Laboratório descartável com SQLite real via `node:sqlite` e adaptador apenas de teste:
- **29/29 PASS**;
- 0004 adiciona apenas os três targets;
- segunda execução é no-op;
- schema já atualizado é no-op estrutural;
- ausência de `clover_weekly_npc_requests` reverte inclusive a coluna adicionada antes da falha e preserva ledger/user_version em 3;
- checksumMaterial cobre os três targets;
- catálogo atual selecionado para legacy real;
- fixtures custom preservam catálogo core por padrão;
- fixture explícita consegue reproduzir catálogo atual até a 0004;
- regressões 0001–0003 permanecem verdes.

## Snapshot real da FASE 0

Somente uma cópia descartável de `/mnt/data/banco-fase0.sqlite` foi escrita.

SHA-256 original e cópia antes da prova:

`45952a05fd9aee1518bb6e575029681f405fd55e4df9981fadbcb78c3a0f1ed6`

Antes:
- `user_version=0`;
- 169 tabelas de domínio;
- 471.430 linhas agregadas;
- fingerprint `39050767cc8bae6d864b6c59bbf4d7a552ea892ee26e8529c4f43966eee979a1`;
- `quick_check=ok`;
- `integrity_check=ok`;
- 0 violações FK.

Após catálogo 0001→0004:
- `user_version=4`;
- ledger `[1,2,3,4]`;
- 169 tabelas de domínio;
- 471.430 linhas agregadas;
- **0 contagens alteradas**;
- fingerprint exatamente idêntico;
- `quick_check=ok`;
- `integrity_check=ok`;
- 0 violações FK;
- `schemaFingerprintMatchesLatest=true`;
- segunda execução `appliedCount=0`.

Portanto, no snapshot real a 0004 é somente adoção formal de schema já existente.

## Segurança

- nenhum `database/legacy.js` alterado;
- nenhum deploy/restart/reload;
- nenhum banco Windows live aberto/escrito;
- nenhum PM2/Mudzap;
- nenhuma mudança em dados de jogador;
- nenhuma reabertura funcional de Raid/Hooks/Squads;
- blobs de upload que falharam no SHA gate ficaram sem referência e não entram em branch/tree/commit.

## Próximo subgate

Continuar migrando pequenos `ensureColumn()` por catálogo modular e, após cobertura suficiente, fazer uma única retirada mecânica/auditada das chamadas já cobertas em `database/legacy.js`.
