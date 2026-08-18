# FASE 2 — extensão do pre-bootstrap canônico até a 0009

Data: 17/08/2026

## Objetivo

Preparar a remoção futura dos 13 `ensureColumn()` de `clover_admin_service_entries` sem quebrar bancos antigos ainda não adotados.

## Mudança

- `schemaBaseCatalog.js` passa de 13 para 14 tabelas-base canônicas;
- a 14ª base é `clover_admin_service_entries`, com o mesmo `CREATE TABLE` do `database/legacy.js`;
- `DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS` passa a incluir `0009_admin_service_columns`;
- pre-bootstrap vazio passa a executar transitoriamente 8 migrations (0002→0009);
- continua proibido criar ledger ou alterar `PRAGMA user_version` antes do legacy;
- fixture custom explicitamente congelada em migrations até 0008 continua em v8;
- boots com legacy real continuam formalizando ledger 0001→0009.

## Por que agora é seguro incluir a 0009

A migration 0009 foi formalizada separadamente no PR #234. As 13 colunas de Admin Service já existem no `CREATE TABLE` canônico e a migration é schema-safe/idempotente. Assim, no pre-bootstrap:

1. a tabela-base é criada ou confirmada;
2. 0009 encontra as 13 colunas e é no-op estrutural em instalação nova;
3. banco antigo recebe quaisquer colunas ausentes antes do legacy;
4. legacy continua responsável por índices e demais efeitos de bootstrap;
5. ledger/user_version só são formalizados depois.

## Gate de catálogo

`schemaBasePrebootstrap.test.js` passa a exigir:

- 14 CREATE TABLEs no catálogo-base e equivalência com o legacy;
- 8 migrations transitórias na allowlist, 0002→0009;
- presença das 13 colunas `ADMIN_SERVICE_TARGETS` antes do legacy;
- rollback remove também a tabela Admin criada na mesma transação;
- fixture custom em v8 permanece v8;
- bootstrap/upgrade com legacy real terminam em `user_version=9` e ledger `[1..9]`.

## Prova isolada do delta v9

Snapshot real da FASE 0 foi copiado de forma descartável.

SHA-256 original e cópia antes da prova:
`45952a05fd9aee1518bb6e575029681f405fd55e4df9981fadbcb78c3a0f1ed6`.

Antes e após garantir a 14ª base + lógica equivalente da 0009:

- 169 tabelas;
- 471.430 linhas agregadas;
- fingerprint `b09c1464fbd67849ff1af77b6bbae3f765d4b75ee037ba5cff6d80dffafef532` idêntico;
- 0 mudanças de contagem;
- `user_version=0`;
- ledger ausente;
- `quick_check=ok`;
- `integrity_check=ok`;
- 0 violações FK.

Em banco vazio isolado:

- `clover_admin_service_entries` nasce com 13/13 targets da 0009;
- `user_version=0`;
- ledger ausente;
- quick/integrity OK;
- 0 violações FK.

## Segurança

- nenhum `database/legacy.js` alterado;
- nenhum ensure removido neste PR;
- nenhum migration checksum alterado;
- nenhum banco Windows live aberto/escrito;
- nenhum deploy/restart/reload;
- PM2/Mudzap intocados;
- Raid/Squads não reabertos.

## Próximo gate

Depois deste merge, os 13 `ensureColumn()` de Admin Service podem entrar num cleanup mecânico separado, com diff de 13 deleções e equivalência original×cleaned antes do merge.
