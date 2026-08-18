# FASE 2 — migration 0011 de identidade/onboarding do personagem

Data: 18/08/2026

## Contexto

Após o cleanup da 0010, o legacy mantém 54 chamadas `ensureColumn()`:

- 45 em `jogadores`;
- 8 em Squads;
- 1 em Raid.

As 45 colunas restantes de `jogadores` foram decompostas em quatro lotes funcionais: 8 identidade/onboarding, 11 aparência/moderação, 13 traços/roll especial e 13 história/estado de jogo.

## Escopo da 0011

`0011_character_identity_columns` versiona somente oito colunas de identidade/onboarding em `jogadores`:

- `personagem_nome` — `TEXT DEFAULT '-'`;
- `personagem_idade` — `INTEGER DEFAULT NULL`;
- `personagem_genero` — `TEXT DEFAULT '-'`;
- `numero_roll_escolhido` — `INTEGER DEFAULT NULL`;
- `ficha_status` — `TEXT DEFAULT 'incompleta'`;
- `ultima_recepcao_em` — `TEXT DEFAULT NULL`;
- `familia_key` — `TEXT DEFAULT NULL`;
- `magia_key` — `TEXT DEFAULT NULL`.

Nenhuma coluna de aparência/moderação, traços, história ou estado de jogo entra nesta migration.

## Estratégia de bootstrap

O pre-bootstrap transitório permanece deliberadamente em `0002→0010` neste gate.

- banco ainda não adotado: pre-bootstrap até 0010 → legacy cria/repara as oito colunas → formalização 0001→0011;
- banco já adotado em v10: 0011 roda pelo fluxo normal e exige `jogadores` existente;
- nenhum `ensureColumn()` é removido neste PR;
- a extensão do pre-bootstrap até 0011 será um gate separado antes do futuro cleanup das oito linhas.

## Gates isolados

Schema antigo descartável com `jogadores(id, nome)`:

- 8/8 colunas adicionadas;
- segunda passagem adiciona 0 colunas;
- tabela ausente falha fechado com `migration_precondition_failed`;
- migration não contém `UPDATE`.

Checksum canônico da 0011 no texto exato enviado ao GitHub:

`c99347af2efbaa82fdb6e3271d220f5091fe1400412c212e85f64b80c9a3cf3f`

## Snapshot real FASE 0

Snapshot `banco-fase0.sqlite`, somente leitura:

- 623 registros em `jogadores`;
- 8/8 colunas já presentes com tipos/defaults compatíveis;
- `personagem_nome`: 0 NULL;
- `personagem_idade`: 404 NULL;
- `personagem_genero`: 0 NULL;
- `numero_roll_escolhido`: 353 NULL;
- `ficha_status`: 0 NULL;
- `ultima_recepcao_em`: 195 NULL;
- `familia_key`: 404 NULL;
- `magia_key`: 389 NULL;
- `quick_check=ok`;
- `integrity_check=ok`;
- 0 violações FK.

A migration é schema-no-op no snapshot; nenhum valor pessoal foi exposto, somente contagens agregadas.

## Regressão

- `databaseMigration0010.test.js` fica explicitamente congelado até v10;
- `databaseMigration0011.test.js` cobre add/no-op/fail-closed/checksum;
- `databaseMigrationCatalog.test.js` passa a formalizar v11;
- boots reais em `schemaBasePrebootstrap.test.js` passam a formalizar ledger `[1..11]`;
- pre-bootstrap vazio continua 15 bases / migrations transitórias `0002→0010`;
- fixture de rollback do pre-bootstrap é deslocada para v12.

## Segurança

- nenhum `database/legacy.js` alterado;
- nenhum schema-base ou allowlist de pre-bootstrap alterado;
- nenhum banco live aberto/escrito;
- nenhum deploy/restart/reload;
- PM2/Mudzap intocados;
- Raid/Squads intocados.
