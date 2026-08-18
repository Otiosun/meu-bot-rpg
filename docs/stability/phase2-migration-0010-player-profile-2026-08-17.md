# FASE 2 — migration 0010 de perfil humano do jogador

Data: 17/08/2026

## Contexto

Após o cleanup da 0009, o legacy mantém 59 chamadas `ensureColumn()`:

- 50 em `jogadores`;
- 8 em Squads;
- 1 em Raid.

Raid e Squads permanecem congelados. As 50 colunas de `jogadores` foram decompostas em blocos menores antes de qualquer cleanup.

## Primeiro lote

A migration `0010_player_profile_columns` cobre somente cinco colunas de perfil humano:

- `display_name` — `TEXT DEFAULT '-'`;
- `nome_real` — `TEXT DEFAULT '-'`;
- `idade_real` — `INTEGER DEFAULT NULL`;
- `gosta_de_fazer` — `TEXT DEFAULT '-'`;
- `disponibilidade_detalhada` — `TEXT DEFAULT '-'`.

Nenhuma outra coluna de `jogadores` entra nesta migration.

## Estratégia de bootstrap

A allowlist transitória do pre-bootstrap permanece em `0002→0009`.

Portanto:

- banco ainda não adotado: pre-bootstrap `0002→0009` → legacy cria/repara `jogadores` → formalização `0001→0010`;
- banco já adotado em v9: `0010` roda pelo fluxo normal e exige que `jogadores` exista;
- `jogadores` ainda não entra no catálogo-base canônico neste gate;
- nenhum `ensureColumn()` de `jogadores` é removido neste PR.

## Gates isolados

Em schema antigo descartável com `jogadores(id, nome)`:

- as cinco colunas foram adicionadas;
- segunda passagem foi no-op;
- tabela ausente falha fechado e preserva ledger em v9.

Checksum canônico da 0010 no source efetivamente versionado:

`517ddca9985ff75411e9f23fa1509fda7893fc4a48ccb8cc3c42f284c4100c4a`

O valor `c6a7b57b63201268e3a366051822ff30ae104cbdfc80f829eec8598d6076a21d` registrado durante a preparação local correspondia a uma serialização anterior da função `up()` com indentação diferente. Como `migrationChecksum()` inclui `String(migration.up)`, a serialização final do source alterou o checksum sem alterar a semântica da migration. O teste foi corrigido para assinar o blob efetivamente versionado antes da continuidade da 0011. A migration 0010 não foi aplicada no live.

A migration não contém `UPDATE`.

## Snapshot real FASE 0

Origem: `banco-fase0.sqlite`.

- 623 registros em `jogadores`;
- as cinco colunas já existem no snapshot;
- `display_name`: 0 NULL;
- `nome_real`: 0 NULL;
- `idade_real`: 404 NULL, compatível com `DEFAULT NULL`;
- `gosta_de_fazer`: 0 NULL;
- `disponibilidade_detalhada`: 0 NULL;
- migration é schema-no-op no snapshot;
- `quick_check=ok`;
- `integrity_check=ok`;
- 0 violações FK.

Nenhum valor pessoal do snapshot foi exposto durante a auditoria; apenas contagens agregadas foram usadas.

## Testes de regressão

- `databaseMigration0009.test.js` fica congelado explicitamente até v9;
- `databaseMigration0010.test.js` cobre add/no-op/fail-closed/checksum;
- `databaseMigrationCatalog.test.js` passa a exigir catálogo atual até v10;
- boots reais em `schemaBasePrebootstrap.test.js` passam a formalizar ledger `[1..10]`;
- fixture custom histórica de pre-bootstrap continua congelada em v8;
- o teste de rollback do pre-bootstrap usa versão 11 para não colidir com a 0010 real.

## Segurança

- nenhum `database/legacy.js` alterado;
- nenhum `schemaBaseCatalog.js` alterado;
- nenhuma allowlist de pre-bootstrap alterada;
- nenhum banco live aberto/escrito;
- nenhum deploy/restart/reload;
- PM2/Mudzap intocados;
- Raid/Squads intocados.
