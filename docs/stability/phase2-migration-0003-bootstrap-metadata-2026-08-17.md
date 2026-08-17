# FASE 2 — migration 0003: bootstrap metadata

Data: 17/08/2026

## Escopo

Segundo lote versionado da FASE 2. Nenhum `ensureColumn()` é removido do legacy neste PR; o objetivo é aumentar a cobertura explícita do schema antes de uma futura remoção mecânica consolidada do DDL duplicado.

A `0003_bootstrap_metadata_columns` cobre quatro colunas pequenas:

- `player_onboarding.step_payload` — `TEXT DEFAULT '{}'`;
- `pending_magic_confirmations.roll_number` — `INTEGER DEFAULT NULL`;
- `group_settings.reception_enabled` — `INTEGER DEFAULT 0`;
- `group_settings.reception_type` — `TEXT DEFAULT NULL`.

Foram escolhidas porque são superfícies pequenas de bootstrap/metadata. Este lote evita deliberadamente `jogadores`, Inventário pesado, Admin Service e domínios Raid/Squads.

## Checksum

A `0003` usa `checksumMaterial` com tabela/coluna/definição explícitas.

Checksum:

`ac9da088be053e0d24297410fda45848283e852389813a820de9073ebd452518`

Os checksums já versionados permanecem:

- 0001: `20e6ea43f54973d8c59148d3076f337a42619db6a857557394c05f8b347ff0c2`;
- 0002: `7d6128d49a2aac5ce26b08078ed00bf7bc4db967a0905aca482223c6663e80c5`.

## Gate local

Suite focada após adicionar a 0003: **24/24 PASS**.

Cobertura específica da 0003:

- adiciona exatamente as quatro colunas quando ausentes;
- segunda execução é no-op;
- é schema-no-op quando as quatro colunas já existem;
- se `group_settings` estiver ausente, a migration falha com `migration_precondition_failed`;
- o rollback remove também colunas que a própria 0003 já tinha adicionado antes da precondição falhar;
- ledger e `user_version` permanecem em 2 após esse rollback;
- checksum hardcoded da 0003 e alteração de `checksumMaterial` são verificados.

Os testes da 0002 foram explicitamente limitados a `CORE_MIGRATIONS.slice(0, 2)` quando testam propriedades históricas da versão 2. Nenhuma asserção foi removida ou enfraquecida.

## Snapshot real da FASE 0

Somente a cópia descartável `/mnt/data/phase2_snapshot_0003.sqlite` foi escrita. O original `/mnt/data/banco-fase0.sqlite` permaneceu intacto.

SHA-256 de ambos antes da aplicação:

`45952a05fd9aee1518bb6e575029681f405fd55e4df9981fadbcb78c3a0f1ed6`

Antes:

- `user_version=0`;
- 169 tabelas de domínio;
- 471.430 linhas agregadas;
- as quatro colunas da 0003 já existiam;
- fingerprint `39050767cc8bae6d864b6c59bbf4d7a552ea892ee26e8529c4f43966eee979a1`;
- `quick_check=ok`;
- `integrity_check=ok`;
- 0 violações em `foreign_key_check`.

Após `0001+0002+0003`:

- `user_version=3`;
- ledger `[1,2,3]`;
- **0 alterações de contagem de linhas** nas tabelas preexistentes;
- fingerprint de domínio exatamente igual ao anterior;
- `quick_check=ok`;
- `integrity_check=ok`;
- 0 violações FK;
- segunda execução: `appliedCount=0`.

Portanto, no snapshot real a 0003 é somente adoção formal de DDL já existente.

## Limites

- `database/legacy.js` permanece fora do diff;
- nenhum live DB/Windows/PM2/Mudzap é tocado;
- nenhum deploy backend;
- nenhuma alteração de dados de jogador;
- a remoção consolidada dos `ensureColumn()` versionados continua sendo um subgate posterior da FASE 2.
