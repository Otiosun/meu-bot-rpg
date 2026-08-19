# FASE 2 — Raid V2 test fixture: alinhar ao pre-bootstrap canônico

Data: 19/08/2026

## Achado

O teste `tests/raidV2.test.js` ainda criava um SQLite cru e chamava
`ensureCloverInventorySchema()` diretamente.

Desde o cleanup das migrations 0002→0008, isso não representa mais o bootstrap
de produção: colunas como `clover_inventory_items.template_key` são preparadas
pela camada de pre-bootstrap antes do legacy. O legacy mantém os índices e
normalizações, mas não volta a adicionar essas colunas por `ensureColumn()`.

## Prova baseline

Antes de qualquer alteração neste slice, o `main` exato
`a7309ba0b5e412bd8aceec5d37915b2ecd677adf` executa `raidV2.test.js` como:

- 5 testes;
- 1 PASS;
- 4 FAIL;
- erro comum: `SQLITE_ERROR: no such column: template_key`;
- stack entra em `ensureCloverInventorySchema()` no fixture.

Portanto a falha antecede e independe da migration 0021.

## Correção

Somente o fixture do teste passa a executar
`prebootstrapCloverSchemaBeforeLegacy(db, { migrations: CURRENT_SCHEMA_MIGRATIONS })`
antes dos helpers legacy.

O fixture também exige que o pre-bootstrap continue terminando em
`0020_raid_v1_bridge`.

## Fora de escopo

- nenhum runtime;
- nenhuma migration;
- nenhum schema de produção;
- nenhum `database/legacy.js`;
- nenhuma 0021;
- nenhum live/DB/PM2/Mudzap.

A migration 0021 deve ser retomada somente depois deste reparo test-only estar
fechado no main.
