# FASE 2 — cleanup final do ensure legado de Raid

Data: 19/08/2026

## Objetivo

Remover somente a última chamada real de `ensureColumn()` do legado, `clover_raids.salary_eligible`, depois de provar cobertura formal pela migration 0020 e pelo pre-bootstrap canônico.

## Prova de cobertura

- `RAID_V1_BRIDGE_TARGETS` possui 20 targets: 14 em `clover_raids` e 6 em `clover_raid_participants`;
- `clover_raids.salary_eligible` está entre os targets da 0020;
- a migration 0020 percorre os targets via `addColumnIfMissing`;
- o pre-bootstrap canônico executa `0020_raid_v1_bridge`;
- o CREATE moderno de Raid já contém `salary_eligible INTEGER NOT NULL DEFAULT 1`;
- o auditor canônico passa de 124 para 144 targets e passa a incluir a 0020;
- cobertura esperada pós-cleanup: 144 targets, 56 presentes nos CREATEs base, 88 ausentes do schema-base, zero ensure coberto;
- o auditor falha fechado se o ensure de Raid for reintroduzido.

## Alteração

- remove exatamente uma chamada:
  `await ensureColumn(db, 'clover_raids', 'salary_eligible', 'INTEGER NOT NULL DEFAULT 1');`
- preserva a função helper `ensureColumn`;
- não altera migrations, pre-bootstrap, catálogo base, runtime de Raid, DB live, PM2 ou Mudzap.

## Escopo esperado

Exatamente 5 arquivos:
- `database/legacy.js`;
- `helpers/clover/schemaBaseConsolidationAudit.js`;
- `tests/schemaBaseConsolidationAudit.test.js`;
- `tests/legacyEnsureColumnCleanup.test.js`;
- este documento.

## Gates

- blobs/base exatos;
- branch nova a partir do main canônico;
- npm ci isolado;
- node --check;
- suites focadas da 0020/base/pre-bootstrap/auditor/cleanup;
- 30 testes, 30 PASS, 0 FAIL;
- zero chamadas reais `await ensureColumn(db,...)`;
- helper preservado;
- `git diff --check`;
- diff de `database/legacy.js` = 0 adições / 1 deleção;
- escopo exato de 5 arquivos;
- anti-race final antes do push;
- push sem force.
