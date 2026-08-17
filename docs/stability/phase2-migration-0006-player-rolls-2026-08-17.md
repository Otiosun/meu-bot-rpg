# FASE 2 — migration 0006 player_rolls

Data: 17/08/2026

## Escopo

`0006_player_roll_columns` versiona onze colunas legadas de `player_rolls`:
- `kingdom` — `TEXT DEFAULT '-'`;
- `grimoire_rank` — `TEXT DEFAULT '-'`;
- `grimoire_symbol` — `TEXT DEFAULT '-'`;
- `magic_scope` — `TEXT DEFAULT '-'`;
- `roll_version` — `TEXT DEFAULT 'legacy'`;
- `kingdom_key` — `TEXT DEFAULT NULL`;
- `social_class_key` — `TEXT DEFAULT NULL`;
- `race_key` — `TEXT DEFAULT NULL`;
- `grimoire_key` — `TEXT DEFAULT NULL`;
- `magic_rarity_key` — `TEXT DEFAULT NULL`;
- `roll_payload` — `TEXT DEFAULT '{}'`.

Checksum:
`072bfc35b3c777a240c8433b974e1c9ed172281570448f102721a159292b6a19`

A migration é adicionada somente ao catálogo modular; `schemaMigrationService.js`, `database.js` e `database/legacy.js` permanecem fora do lote.

## Schema-base

O `CREATE TABLE` legado já contém quatro das onze colunas (`kingdom`, `grimoire_rank`, `grimoire_symbol`, `magic_scope`). As outras sete ainda dependem de `ensureColumn()`. Portanto nenhuma chamada legada é removida neste PR.

## Gate local

Suíte focada: **38/38 PASS**.

Cobertura específica:
- 0006 adiciona as onze colunas e segunda execução é no-op;
- schema-base com as quatro colunas antigas adiciona apenas as sete modernas;
- schema já completo é no-op estrutural;
- `player_rolls` ausente falha fechado e preserva ledger/user_version em 0005;
- checksumMaterial cobre todos os onze targets;
- testes históricos da 0005 ficam fixados em migrations até a versão 5;
- catálogo explícito passa a exigir versão 6.

## Snapshot real

Cópia descartável de `/mnt/data/banco-fase0.sqlite`.

SHA-256 original e cópia antes da prova:
`45952a05fd9aee1518bb6e575029681f405fd55e4df9981fadbcb78c3a0f1ed6`

Antes:
- `user_version=0`;
- 169 tabelas de domínio;
- 471.430 linhas agregadas;
- `player_rolls`: 997 registros;
- fingerprint `39050767cc8bae6d864b6c59bbf4d7a552ea892ee26e8529c4f43966eee979a1`;
- quick/integrity OK;
- 0 violações FK.

Após 0001→0006:
- `user_version=6`;
- ledger `[1,2,3,4,5,6]`;
- 169 tabelas / 471.430 linhas preservadas;
- **0 contagens alteradas**;
- fingerprint exatamente idêntico;
- quick/integrity OK;
- 0 violações FK;
- `schemaFingerprintMatchesLatest=true`;
- segunda execução `appliedCount=0`.

## Segurança

- nenhum deploy/restart/reload;
- nenhum banco Windows live aberto/escrito;
- nenhum PM2/Mudzap;
- nenhuma mudança de dados de jogador;
- nenhuma reabertura funcional de Raid/Hooks/Squads.
