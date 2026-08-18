# FASE 2 — migration 0013 de avatar do site

Data: 18/08/2026

## Objetivo

Versionar separadamente as duas colunas de avatar do site que ainda permanecem como `ensureColumn()` em `jogadores`:

- `site_profile_image_data TEXT DEFAULT NULL`;
- `site_profile_image_updated_at TEXT DEFAULT NULL`.

Elas foram deliberadamente excluídas da migration 0012 porque possuem writer próprio (`profileImageService`) e não fazem parte do estado transacional de moderação de aparência.

## Escopo da 0013

`0013_site_profile_image_columns` contém apenas os dois targets acima e usa `addColumnIfMissing`.

A migration:

- não contém `UPDATE`;
- não contém backfill;
- não normaliza imagem;
- não toca `appearanceManager`;
- não toca `profileImageService`;
- não remove os dois `ensureColumn()` neste PR;
- não altera ainda a allowlist de pre-bootstrap.

Checksum canônico:

`f74c972fefbdee10f3a1b10826d5cfc02058996771b55e0f84251e59dfaa9d50`

O checksum foi calculado com o mesmo algoritmo de `migrationChecksum`; a reprodução local desse algoritmo também reproduziu exatamente o checksum já congelado da migration 0012.

## Prova em schema antigo descartável

Em `jogadores` com o schema anterior até 0012, sem as duas colunas de avatar:

- primeira passagem adiciona 2/2 colunas;
- segunda passagem adiciona 0;
- tipos/defaults finais: `TEXT DEFAULT NULL` para ambas;
- dados pré-existentes das demais colunas permanecem iguais;
- ausência de `jogadores` falha fechado como `migration_precondition_failed`.

## Snapshot real FASE 0

Cópia descartável de `banco-fase0.sqlite`:

- 623 jogadores antes/depois;
- as duas colunas já existem no snapshot com tipo `TEXT` e default `NULL`;
- migration adiciona 0 colunas;
- fingerprint de schema de domínio permanece idêntico;
- contagens agregadas do estado de avatar permanecem idênticas antes/depois;
- `quick_check=ok`;
- `integrity_check=ok`;
- 0 violações FK.

Nenhum conteúdo de imagem ou identificador pessoal foi exposto; apenas estrutura e contagens agregadas foram usadas.

## Estratégia de bootstrap

Neste PR, o pre-bootstrap transitório continua deliberadamente em `0002→0012`.

- banco ainda não adotado: pre-bootstrap até 0012 → legacy ainda garante as duas colunas → formalização 0001→0013;
- banco já adotado até v12: a 0013 roda antes do legacy e exige `jogadores` existente;
- o próximo gate será promover `0013_site_profile_image_columns` ao pre-bootstrap;
- somente depois disso as duas chamadas `ensureColumn()` poderão ser removidas.

## Regressão

- `databaseMigration0012.test.js` fica congelado explicitamente até v12;
- `databaseMigration0013.test.js` cobre add/no-op, preservação de avatar existente, fail-closed, checksum e ausência de `UPDATE`;
- `databaseMigrationCatalog.test.js` passa a formalizar catálogo até v13;
- boots reais em `schemaBasePrebootstrap.test.js` passam a formalizar ledger `[1..13]`;
- o teste de pre-bootstrap vazio continua exigindo somente `0002→0012` neste gate;
- a fixture artificial de rollback é deslocada para v14.

## Segurança

- nenhum `database/legacy.js` alterado;
- nenhum `schemaBaseCatalog.js` alterado;
- nenhuma allowlist de pre-bootstrap alterada;
- nenhum `profileImageService.js` alterado;
- nenhum banco live aberto ou escrito;
- nenhum deploy/restart/reload;
- PM2/Mudzap intocados;
- Raid/Squads intocados.
