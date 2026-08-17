# FASE 2 — gate de consolidação do schema-base

Data: 17/08/2026

## Estado após 0008

As migrations explícitas 0002→0008 cobrem 53 chamadas `ensureColumn()` do bootstrap legado.

Classificação contra o blob canônico atual de `database/legacy.js` (`e1d1be88262a3a88b11e13d13af7a4b2ad1b6435`):
- 53 targets migrados;
- 15 colunas já constam no respectivo `CREATE TABLE`;
- 38 colunas ainda não constam no schema-base e dependem de `ensureColumn()` em instalação nova/legado antigo;
- 53 chamadas `ensureColumn()` continuam presentes.

A cópia local usada no gate, após normalizar somente CRLF→LF, produz exatamente o Git blob `e1d1be88262a3a88b11e13d13af7a4b2ad1b6435`.

Por migration:
- 0002: 4 presentes / 1 ausente (`clover_inventory_reservations.expires_at`);
- 0003: 3 presentes / 1 ausente (`player_onboarding.step_payload`);
- 0004: 0 presentes / 3 ausentes;
- 0005: 4 presentes / 2 ausentes (`salary_eligible`, `salary_service_type`);
- 0006: 4 presentes / 7 ausentes (campos modernos de `player_rolls`);
- 0007: 0 presentes / 7 ausentes (`clover_item_templates`);
- 0008: 0 presentes / 17 ausentes (`clover_inventory_items`).

## Bloqueio de remoção

Nenhuma das 53 chamadas deve ser removida ainda, inclusive as 15 cujo `CREATE TABLE` já possui a coluna.

Motivo: um banco antigo ainda não adotado (`user_version=0`, sem ledger) permanece `legacy-first`. Nesse caminho, `ensureColumn()` continua sendo o reparo compatível de schemas antigos antes da baseline 0001. Remover essas chamadas antes de existir um pre-bootstrap canônico quebraria upgrades de bancos legados não adotados.

## Dependências pós-DDL comprovadas

O auditor mantém marcadores fail-closed para pontos onde o bootstrap usa colunas logo após os ensures:
- `clover_market_listings.idempotency_key` → índice único `idx_clover_market_listings_idempotency`;
- Quick Evaluations: `scene_sent_at/scene_source` → `idx_clover_quick_evaluations_scene`;
- Quick Evaluations: `quoted_message_key` → `idx_clover_quick_evaluations_quoted_message`;
- Quick Evaluations: `scene_sent_at` → `normalizeQuickEvaluationWeekKeys`;
- Item Templates: `requestable` → `idx_clover_item_templates_requestable`;
- Inventory Items: `template_key/status` → `idx_clover_inventory_template_status`;
- Inventory Items: `equipped_slot` → `idx_clover_inventory_equipped_slot`;
- Inventory Items: campos de classificação/preço → `UPDATE clover_inventory_items` de normalização legado.

## Próxima arquitetura

O próximo subgate não é apagar `ensureColumn()`. É construir um **pre-bootstrap canônico** para tabelas já cobertas por migrations:

1. garantir a existência das tabelas-base necessárias sem executar índices/normalizações dependentes;
2. em banco não adotado, executar migrations explícitas depois das tabelas-base e antes do restante do legacy;
3. só então executar índices, seeds e normalizações pós-schema;
4. provar bootstrap vazio, upgrade de schema antigo e snapshot real;
5. depois disso, remover `ensureColumn()` em lote mecânico/auditado.

Esse desenho mantém o modular monolith e evita rewrite do `database/legacy.js`.

## Auditor versionado

`helpers/clover/schemaBaseConsolidationAudit.js`:
- deriva os 53 targets diretamente dos catálogos de migration;
- classifica presença no `CREATE TABLE` e presença do `ensureColumn()`;
- valida contagens esperadas 53/15/38/53;
- valida dependências pós-DDL conhecidas;
- retorna `removalGate = blocked_until_canonical_prebootstrap`;
- falha fechado se um ensure coberto ou uma dependência for removido cedo demais.

`scripts/auditCloverSchemaBaseCoverage.js` executa o gate somente leitura e emite um resumo JSON para auditoria/release tooling.

Validação local contra o blob canônico atual:
- `node --check` no helper e CLI: PASS;
- `node --test tests/schemaBaseConsolidationAudit.test.js`: **5/5 PASS**;
- CLI: PASS, cobertura 53/15/38/53, oito dependências presentes.

## Segurança

- auditor é somente leitura/estático;
- nenhum banco é aberto;
- nenhum deploy/restart/PM2/Mudzap;
- nenhum dado de jogador;
- nenhum `database.js`, `database/legacy.js` ou engine de migrations alterado neste gate.
