# FASE 2 — cleanup dos ensureColumn de Squads

Data: 19/08/2026

## Escopo

- remove exatamente 8 chamadas `ensureColumn()` de `clover_squads`;
- mantém intacta a definição/helper `ensureColumn`;
- mantém exatamente 1 chamada real restante: `clover_raids.salary_eligible`;
- Raid continua congelado e fora da migração;
- não altera CREATE de `clover_squads`;
- não altera índices ou dados.

## Base de segurança

A migration 0019 já está no catálogo formal e no pre-bootstrap canônico.
A prova de schema legado confirmou que uma `clover_squads` antiga recebe as 8 colunas antes do legacy sem ledger/user_version e preservando dados.

## Auditor canônico

O auditor passa a cobrir também a 0019:

- targets: 116 → 124;
- basePresent: 28 → 36;
- baseMissing: 88;
- legacyEnsurePresent: 0.

O índice `idx_clover_squads_group` passa a ser dependência pós-DDL protegida.

## Segurança operacional

- live/DB/PM2/Mudzap não são acessados;
- nenhum force push;
- branch/main são verificados novamente imediatamente antes do push.
