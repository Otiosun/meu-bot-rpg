# FASE 2 — pre-bootstrap canônico até a 0013

Data: 18/08/2026

## Objetivo

Promover `0013_site_profile_image_columns` para o pre-bootstrap transitório antes de qualquer cleanup das duas chamadas `ensureColumn()` de avatar do site.

`jogadores` já é tabela-base canônica. Portanto este gate não altera `schemaBaseCatalog.js`.

## Delta

`DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS` passa de `0002→0012` para `0002→0013`.

A única mudança operacional é permitir que a 0013 garanta antes do legacy:

- `site_profile_image_data TEXT DEFAULT NULL`;
- `site_profile_image_updated_at TEXT DEFAULT NULL`.

O pre-bootstrap continua sem criar ledger e sem alterar `PRAGMA user_version`.

## Prova isolada do delta v13

Em banco descartável contendo `jogadores` com o schema anterior e sem as duas colunas da 0013:

- 2/2 colunas adicionadas na primeira passagem;
- segunda passagem adiciona 0 colunas;
- dados pré-existentes das demais colunas permanecem iguais;
- `user_version=0`;
- ledger de migrations ausente;
- ausência de `jogadores` continua falhando fechado.

## Snapshot real FASE 0

Cópia descartável de `banco-fase0.sqlite`:

- 623 jogadores antes/depois;
- 0 colunas adicionadas porque ambas já existem;
- fingerprint de schema de domínio idêntico antes/depois;
- contagens agregadas do estado de avatar idênticas antes/depois;
- `quick_check=ok`;
- `integrity_check=ok`;
- 0 violações FK;
- `user_version=0` no cenário de pre-bootstrap;
- ledger ausente.

Nenhuma imagem ou identificador pessoal foi exposto.

## Teste versionado

`schemaBasePrebootstrap.test.js` passa a exigir:

- 15 tabelas-base;
- 12 migrations transitórias `0002→0013`;
- as duas colunas de `SITE_PROFILE_IMAGE_TARGETS` presentes antes do legacy;
- ausência de ledger;
- `user_version=0`;
- segunda execução idempotente.

Os testes de bootstrap formal continuam fechando em `user_version=13` e ledger `[1..13]`.

## Segurança

- nenhum `database/legacy.js` alterado;
- nenhum `schemaBaseCatalog.js` alterado;
- nenhuma migration alterada;
- nenhum `profileImageService.js` alterado;
- nenhum banco live aberto/escrito;
- nenhum deploy/restart/reload;
- PM2/Mudzap intocados;
- Raid/Squads intocados.

Após este gate, as duas chamadas `ensureColumn()` da 0013 poderão ser removidas em cleanup mecânico separado, com diff estrito e equivalência original × cleaned.
