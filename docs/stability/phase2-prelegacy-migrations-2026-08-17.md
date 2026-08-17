# FASE 2 — pre-legacy migrations e primeiro lote versionado

Data: 17/08/2026

## Objetivo

Começar a retirada gradual de DDL implícito de `database/legacy.js` sem reescrever o bootstrap e sem tocar no banco/runtime Windows live.

Este lote mantém `database/legacy.js` byte a byte inalterado. Ele cria a ponte necessária para migrations futuras poderem rodar antes do bootstrap legado em bancos que já adotaram a baseline `0001`.

## Estratégia de transição

`criarBanco()` passa a ter dois caminhos:

1. **Banco ainda não adotado** (`user_version=0`, sem ledger): o preflight não cria ledger e preserva `legacy-first`; depois do legacy, o migrator adota `0001` e aplica `0002`.
2. **Banco já adotado** (ledger coerente com `0001`): migrations pendentes rodam em conexão canônica antes do legacy; depois do legacy o migrator roda novamente como verificação/no-op.

Fixtures/callers que injetam `createLegacyDatabase` sem um `openMigrationDatabase` explícito preservam o contrato anterior e executam somente a baseline `0001` no pós-legacy. Isso impede que schemas parciais de teste passem a exigir tabelas da `0002` por acidente.

Estados incoerentes falham antes do legacy:
- ledger fora da sequência canônica;
- `user_version` divergente do maior ledger aplicado;
- `user_version > 0` sem `clover_schema_migrations`.

## Migration 0002

`0002_low_risk_legacy_columns` versiona cinco colunas pequenas que o legacy já assegura:

- `clover_character_stats.ph_accumulated` — `INTEGER DEFAULT 0`;
- `clover_character_stats.ph_available` — `INTEGER DEFAULT 0`;
- `clover_box_openings.roll_basis_points` — `INTEGER DEFAULT NULL`;
- `clover_inventory_reservations.expires_at` — `TEXT DEFAULT NULL`;
- `clover_consumable_uses.effect_category` — `TEXT DEFAULT NULL`.

Neste PR **os `ensureColumn()` correspondentes ainda não são removidos**. Primeiro provamos ordem, idempotência, rollback e compatibilidade. A retirada do DDL duplicado será um lote posterior.

A migration falha com `migration_precondition_failed` se uma tabela obrigatória estiver ausente. Como toda a `up()` roda sob `BEGIN IMMEDIATE`, colunas adicionadas antes da precondição que falhou são revertidas.

## Checksum

A `0001` preserva exatamente o algoritmo/material anterior e mantém checksum:

`20e6ea43f54973d8c59148d3076f337a42619db6a857557394c05f8b347ff0c2`

Migrations novas podem fornecer `checksumMaterial`. A `0002` inclui explicitamente sua lista de tabela/coluna/definição no checksum, evitando que SQL/targets externos mudem sem alterar a identidade da migration.

Checksum da `0002`:

`7d6128d49a2aac5ce26b08078ed00bf7bc4db967a0905aca482223c6663e80c5`

## Testes isolados

Laboratório descartável com SQLite real por `node:sqlite` e adaptador local somente de teste:

- regressões da fundação ajustadas: 6/6 PASS;
- novos contratos da FASE 2/compatibilidade: 13/13 PASS;
- total focado: **19/19 PASS**.

Cobertura nova:
- checksum da 0001 permanece compatível;
- 0002 adiciona somente as cinco colunas e segunda execução é no-op;
- 0002 é schema-no-op quando legacy já criou as colunas;
- tabela obrigatória ausente reverte a transação e preserva baseline;
- `checksumMaterial` protege targets externos;
- ledger com gap falha fechado;
- `user_version` adulterado falha antes de aplicar;
- pre-legacy não cria ledger em banco não adotado;
- banco baseline 0001 aplica 0002 antes do legacy;
- instalação não adotada preserva legacy-first;
- estado ledger/user_version incoerente não chama legacy;
- `user_version` sem ledger não chama legacy;
- custom legacy sem opener permanece baseline-only para fixtures antigas.

## Prova contra snapshot real da FASE 0

Somente uma cópia descartável de `/mnt/data/banco-fase0.sqlite` foi escrita. O original não foi alterado.

SHA-256 do original e da cópia antes do teste:

`45952a05fd9aee1518bb6e575029681f405fd55e4df9981fadbcb78c3a0f1ed6`

Antes:
- `user_version=0`;
- 169 tabelas de domínio;
- 471.430 linhas agregadas;
- as cinco colunas da 0002 já existiam;
- `quick_check=ok`;
- `integrity_check=ok`;
- 0 violações em `foreign_key_check`.

Após `0001+0002`:
- `user_version=2`;
- ledger `[0001_baseline_adoption, 0002_low_risk_legacy_columns]`;
- **0 tabelas preexistentes mudaram contagem de linhas**;
- fingerprint de domínio permaneceu exatamente `39050767cc8bae6d864b6c59bbf4d7a552ea892ee26e8529c4f43966eee979a1`;
- `quick_check=ok`;
- `integrity_check=ok`;
- 0 violações FK;
- segunda execução: `appliedCount=0`.

Portanto, no snapshot real a `0002` é uma adoção formal de DDL já existente, sem mutação de dados ou schema de domínio.

## Limites deliberados

- nenhum `ensureColumn()` removido neste lote;
- nenhum `CREATE TABLE` de domínio movido ainda;
- nenhuma alteração em `database/legacy.js`;
- nenhum banco Windows live aberto/escrito;
- nenhum restart/reload/PM2/Mudzap;
- nenhuma mudança de Raid, Squads, rewards, Auth ou dados de jogador.

## Próximo lote da FASE 2

Após este gate, retirar o primeiro conjunto de `ensureColumn()` já pertencente à `0002`, provar bootstrap vazio + snapshot + segunda inicialização, e então avançar em pequenos grupos para os demais domínios. Tabelas de alto impacto (`jogadores`, Inventário, Admin Service) ficam deliberadamente para depois dos lotes pequenos.
