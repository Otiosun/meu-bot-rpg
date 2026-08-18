# FASE 2 — pre-bootstrap canônico até a 0012

Data: 18/08/2026

## Objetivo

Promover `0012_appearance_moderation_columns` para o pre-bootstrap transitório antes de qualquer cleanup das nove chamadas `ensureColumn()` correspondentes em `jogadores`.

`jogadores` já é a 15ª tabela-base canônica. Portanto este gate não altera `schemaBaseCatalog.js`.

## Delta

`DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS` passa de `0002→0011` para `0002→0012`.

A única mudança operacional é permitir que a 0012 garanta antes do legacy:

- `personagem_aparencia`;
- `personagem_aparencia_normalizada`;
- `personagem_aparencia_status`;
- `personagem_aparencia_motivo`;
- `personagem_aparencia_image_path`;
- `personagem_aparencia_image_message_id`;
- `personagem_aparencia_approved_by`;
- `personagem_aparencia_approved_at`;
- `personagem_aparencia_updated_at`.

As duas colunas de avatar do site continuam fora deste gate.

O pre-bootstrap continua sem criar ledger e sem alterar `PRAGMA user_version`.

## Prova isolada do delta v12

Em banco descartável contendo `jogadores` com as colunas dos lotes anteriores e sem as nove colunas da 0012:

- 9/9 colunas adicionadas na primeira passagem;
- segunda passagem adiciona 0 colunas;
- `user_version=0`;
- ledger de migrations ausente;
- `quick_check=ok`;
- `integrity_check=ok`;
- 0 violações FK.

## Snapshot real FASE 0

Cópia descartável de `banco-fase0.sqlite`:

- 623 jogadores antes/depois;
- 0 colunas adicionadas porque as nove já existem;
- fingerprint de schema idêntico antes/depois;
- distribuição de moderação idêntica: 210 `approved`, 409 `pending`, 4 `rejected`;
- `user_version=0`;
- ledger ausente;
- `quick_check=ok`;
- `integrity_check=ok`;
- 0 violações FK.

A prova não executa backfill ou normalização de dados.

## Teste versionado

`schemaBasePrebootstrap.test.js` passa a exigir:

- 15 tabelas-base;
- 11 migrations transitórias `0002→0012`;
- as nove colunas de `APPEARANCE_MODERATION_TARGETS` presentes antes do legacy;
- ausência de ledger;
- `user_version=0`;
- segunda execução idempotente.

A fixture de rollback já está em v13 e continua válida.

## Segurança

- nenhum `database/legacy.js` alterado;
- nenhum `schemaBaseCatalog.js` alterado;
- nenhuma migration alterada;
- nenhum workflow de aparência alterado;
- nenhum banco Windows live aberto/escrito;
- nenhum deploy/restart/reload;
- PM2/Mudzap intocados;
- Raid/Squads intocados.

Após este gate, as nove chamadas `ensureColumn()` da 0012 poderão ser avaliadas para cleanup mecânico em PR separado, com equivalência original × cleaned e SHA exato do legacy.
