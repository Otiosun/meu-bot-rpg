# FASE 2 — remoção dos 53 ensureColumn já migrados

Data: 17/08/2026

## Pré-condições já fechadas no main

- migrations 0002→0008 cobrem 53 colunas;
- gate de schema-base #230 classificou 53/15/38/53;
- pre-bootstrap canônico #231 prepara 13 tabelas-base e executa transitoriamente 0002→0008 antes do legacy em banco ainda não adotado;
- gate de bypass #232 exige uma única ponte de produção para `database/legacy.js`.

## Escopo deste cleanup

`database/legacy.js` canônico antes do cleanup: Git blob `e1d1be88262a3a88b11e13d13af7a4b2ad1b6435`.

Foram removidas **exatamente 53 chamadas** `await ensureColumn(...)` cujos pares tabela/coluna pertencem às migrations 0002→0008.

Depois do cleanup:
- 0/53 chamadas migradas permanecem;
- 72 `ensureColumn()` de domínios ainda não migrados permanecem intactos;
- nenhum `CREATE TABLE`, índice, seed, normalização ou UPDATE foi removido;
- Git blob candidato do legacy: `970e6375699f2e9ee20483994844852b1df2d95f`.

## Gate estático

`schemaBaseConsolidationAudit` passa a exigir:
- totalTargets=53;
- basePresent=15;
- baseMissing=38;
- legacyEnsurePresent=0;
- todas as 8 dependências pós-DDL presentes;
- `requiresLegacyRepairBeforeBaseline=false`;
- `removalGate=passed_canonical_prebootstrap`.

`legacyEnsureColumnCleanup.test.js` falha se:
- qualquer um dos 53 ensures voltar;
- o número de ensures não migrados deixar de ser 72 sem uma migration correspondente;
- índice/normalização dependente desaparecer.

Gate local estático: **8/8 PASS**.

## Prova dinâmica original × cleaned

O legacy original e o legacy candidato foram executados em bancos SQLite descartáveis separados usando o mesmo runtime compatível de laboratório.

### Instalação vazia após pre-bootstrap canônico

- 13 tabelas-base preparadas;
- 15 colunas já presentes no CREATE;
- 38 adicionadas transitoriamente antes do legacy;
- após bootstrap: 68 tabelas em ambos;
- schema normalizado idêntico;
- contagens idênticas;
- dados idênticos;
- quick_check=ok / integrity_check=ok / 0 FK violations em ambos.

### Schema antigo não adotado com dados preexistentes

Foram preservados registros antigos em `player_rolls`, `clover_inventory_items` e `clover_item_templates` antes do pre-bootstrap.

Após original e cleaned:
- 68 tabelas em ambos;
- schema idêntico;
- contagens idênticas;
- dados lógicos idênticos;
- as únicas diferenças byte-a-byte observadas foram timestamps de bootstrap criados em execuções sequenciais (`clover_recruitment_events` e `clover_settings`), com conteúdo lógico igual;
- quick/integrity OK e 0 FK violations.

### Segunda inicialização / schema já completo

- schema idêntico;
- contagens idênticas;
- dados lógicos idênticos;
- quick/integrity OK;
- 0 FK violations.

### Snapshot real da FASE 0

Origem: `banco-fase0.sqlite`.

SHA-256 antes das cópias:
`45952a05fd9aee1518bb6e575029681f405fd55e4df9981fadbcb78c3a0f1ed6`.

Antes e após o legacy cleaned:
- 169 tabelas;
- 471.430 linhas agregadas;
- schema normalizado idêntico;
- 0 mudanças de contagem;
- 0 mudanças de dados lógicos;
- quick_check=ok;
- integrity_check=ok;
- 0 FK violations.

O legacy original e o cleaned também produziram resultados idênticos no snapshot.

## Segurança

- nenhum banco Windows live foi aberto/escrito;
- nenhum deploy/restart/reload;
- PM2/Mudzap intocados;
- nenhum migration checksum foi alterado;
- nenhum `database.js`, `schemaMigrationService.js`, `schemaMigrationCatalog.js` ou pre-bootstrap foi modificado;
- cleanup estritamente mecânico dos 53 ensures já cobertos.
