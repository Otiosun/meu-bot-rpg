# FASE 2 — pre-bootstrap canônico até a 0011

Data: 18/08/2026

## Objetivo

Promover `0011_character_identity_columns` para o pre-bootstrap transitório antes da remoção das oito chamadas `ensureColumn()` correspondentes em `jogadores`.

`jogadores` já é a 15ª tabela-base canônica desde o PR #238, portanto este gate não altera `schemaBaseCatalog.js`.

## Delta

`DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS` passa de `0002→0010` para `0002→0011`.

A única mudança operacional é permitir que a migration 0011 garanta, antes do legacy:

- `personagem_nome`;
- `personagem_idade`;
- `personagem_genero`;
- `numero_roll_escolhido`;
- `ficha_status`;
- `ultima_recepcao_em`;
- `familia_key`;
- `magia_key`.

O pre-bootstrap continua sem criar ledger e sem alterar `PRAGMA user_version`.

## Prova em banco pré-bootstrapped v10

Origem: banco vazio já preparado pelo gate v10, contendo 15 tabelas-base e `jogadores` com 29 colunas.

Antes:

- 15 tabelas;
- `jogadores`: 29 colunas;
- 0/8 colunas da 0011 presentes;
- `user_version=0`;
- ledger ausente.

Após aplicar somente o delta da 0011:

- exatamente 8/8 colunas adicionadas;
- 15 tabelas permanecem;
- `jogadores`: 37 colunas;
- `user_version=0`;
- ledger continua ausente;
- `quick_check=ok`;
- `integrity_check=ok`;
- 0 violações FK;
- segunda execução adiciona 0 colunas.

O teste versionado exige 15 bases e 10 migrations transitórias (`0002→0011`).

## Snapshot real FASE 0

Cópia descartável do snapshot `banco-fase0.sqlite`:

Antes e depois do delta v11:

- 169 tabelas;
- 471.430 linhas;
- 623 registros em `jogadores`;
- 0 colunas adicionadas porque as 8 já existem;
- fingerprint de schema idêntico: `39050767cc8bae6d864b6c59bbf4d7a552ea892ee26e8529c4f43966eee979a1`;
- `user_version=0`;
- ledger ausente;
- `quick_check=ok`;
- `integrity_check=ok`;
- 0 violações FK.

Nenhum valor pessoal foi lido ou exposto; somente estrutura e contagens agregadas.

## Segurança

- nenhum `database/legacy.js` alterado;
- nenhum `schemaBaseCatalog.js` alterado;
- nenhuma migration alterada;
- nenhum banco Windows live aberto/escrito;
- nenhum deploy/restart/reload;
- PM2/Mudzap intocados;
- Raid/Squads intocados.

Após este gate, as oito chamadas `ensureColumn()` da 0011 poderão ser avaliadas para cleanup mecânico em PR separado, com equivalência original × cleaned e SHA exato do legacy.
