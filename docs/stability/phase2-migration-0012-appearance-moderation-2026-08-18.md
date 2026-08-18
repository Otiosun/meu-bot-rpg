# FASE 2 — migration 0012 de moderação de aparência

Data: 18/08/2026

## Contexto

Após o cleanup da 0011, o legacy mantém 46 chamadas `ensureColumn()`:

- 37 em `jogadores`;
- 8 em Squads;
- 1 em Raid.

O bloco originalmente classificado como “11 aparência/moderação” foi reavaliado antes da migration. As colunas `site_profile_image_data` e `site_profile_image_updated_at` possuem writer próprio (`profileImageService`) e representam avatar do site, não o estado de moderação da aparência. Por redução de blast radius, elas foram separadas deste lote.

## Escopo da 0012

`0012_appearance_moderation_columns` versiona somente nove colunas do workflow de aparência em `jogadores`:

- `personagem_aparencia` — `TEXT DEFAULT '-'`;
- `personagem_aparencia_normalizada` — `TEXT DEFAULT NULL`;
- `personagem_aparencia_status` — `TEXT DEFAULT 'pending'`;
- `personagem_aparencia_motivo` — `TEXT DEFAULT NULL`;
- `personagem_aparencia_image_path` — `TEXT DEFAULT NULL`;
- `personagem_aparencia_image_message_id` — `TEXT DEFAULT NULL`;
- `personagem_aparencia_approved_by` — `TEXT DEFAULT NULL`;
- `personagem_aparencia_approved_at` — `TEXT DEFAULT NULL`;
- `personagem_aparencia_updated_at` — `TEXT DEFAULT NULL`.

As duas colunas de avatar do site ficam fora da 0012.

## Semântica preservada

`appearanceManager` usa essas colunas como estado operacional do fluxo de aprovação:

- `personagem_aparencia_normalizada` participa da assinatura usada no compare-and-set da avaliação;
- `personagem_aparencia_status` controla `pending/approved/rejected`;
- `approved_by`, `approved_at`, `motivo` e `updated_at` registram auditoria;
- image path/message id preservam a associação da imagem enviada;
- rejeição pode bloquear `jogo_status`, mas a 0012 não toca nessas colunas de jogo.

Por isso a migration é estritamente DDL idempotente e não contém `UPDATE`, backfill ou normalização de dados.

## Estratégia de bootstrap

O pre-bootstrap transitório permanece deliberadamente em `0002→0011` neste gate.

- banco ainda não adotado: pre-bootstrap até 0011 → legacy cria/repara as nove colunas → formalização 0001→0012;
- banco já adotado em v11: 0012 roda pelo fluxo normal e exige `jogadores` existente;
- nenhum `ensureColumn()` de aparência é removido neste PR;
- a extensão do pre-bootstrap até 0012 será gate separado antes de qualquer cleanup.

## Gates isolados

Em schema antigo descartável contendo todas as migrations anteriores, mas sem as nove colunas de aparência:

- 9/9 colunas foram adicionadas;
- segunda passagem adicionou 0 colunas;
- tabela ausente falha fechado e preserva ledger em v11;
- migration não contém `UPDATE`.

Checksum canônico da 0012 no source versionado:

`7c9d6258a8a80ec535b8d08d2e3e2dca109416e4bd167ffc7cb2c4b98cc2d90f`

## Snapshot real FASE 0

Cópia descartável de `banco-fase0.sqlite`:

- 623 jogadores antes/depois;
- 9/9 colunas já presentes com tipos/defaults compatíveis;
- migration adiciona 0 colunas;
- fingerprint de schema idêntico antes/depois;
- distribuição de estado preservada: 210 `approved`, 409 `pending`, 4 `rejected`;
- 0 aprovados/rejeitados sem `approved_by`;
- 0 aprovados/rejeitados sem `approved_at`;
- 0 pendentes com `approved_by` preenchido;
- `quick_check=ok`;
- `integrity_check=ok`;
- 0 violações FK.

Nenhum valor pessoal foi exposto; apenas estrutura e contagens agregadas foram usadas.

## Regressão

- `databaseMigration0011.test.js` fica congelado explicitamente até v11;
- `databaseMigration0012.test.js` cobre add/no-op/fail-closed/checksum/ausência de UPDATE;
- `databaseMigrationCatalog.test.js` passa a formalizar catálogo até v12;
- boots reais em `schemaBasePrebootstrap.test.js` passam a formalizar ledger `[1..12]`;
- pre-bootstrap vazio continua 15 bases / migrations transitórias `0002→0011`;
- fixture de rollback do pre-bootstrap é deslocada para v13.

## Segurança

- nenhum `database/legacy.js` alterado;
- nenhum `schemaBaseCatalog.js` alterado;
- nenhuma allowlist de pre-bootstrap alterada;
- nenhum workflow de aparência alterado;
- nenhum banco live aberto/escrito;
- nenhum deploy/restart/reload;
- PM2/Mudzap intocados;
- Raid/Squads intocados.
