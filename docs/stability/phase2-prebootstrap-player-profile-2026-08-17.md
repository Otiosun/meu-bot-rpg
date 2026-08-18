# FASE 2 — pre-bootstrap canônico de jogadores até a 0010

Data: 17/08/2026

## Objetivo

Desbloquear a futura remoção dos cinco `ensureColumn()` de perfil humano de `jogadores` sem quebrar bancos ainda não adotados.

## Escopo

- adicionar `jogadores` como 15ª tabela-base canônica;
- copiar no catálogo-base somente o `CREATE TABLE IF NOT EXISTS jogadores` já existente no legacy;
- incluir `0010_player_profile_columns` na allowlist transitória do pre-bootstrap;
- manter ledger e `PRAGMA user_version` intocados antes do legacy;
- não remover nenhum `ensureColumn()` neste gate.

## Estado do pre-bootstrap

Após este gate:

- 15 tabelas-base canônicas;
- 9 migrations transitórias: `0002→0010`;
- `jogadores` nasce com as 24 colunas do CREATE legado;
- a 0010 adiciona transitoriamente 5 colunas de perfil humano;
- as outras 45 colunas ainda dependentes do legacy permanecem protegidas pelos respectivos `ensureColumn()`.

## Prova no snapshot real FASE 0

Cópia descartável de `banco-fase0.sqlite`:

- 169 tabelas antes e depois;
- 471.430 linhas agregadas antes e depois;
- 623 registros em `jogadores`;
- fingerprint de schema antes/depois idêntico: `39778b1e9c44942516fbbfe7ea028385d23ac999ec9caf8878e2cc4f88959018`;
- `user_version=0` antes e depois;
- ledger de migrations ausente antes e depois;
- `quick_check=ok`;
- `integrity_check=ok`;
- 0 violações FK.

## Prova em banco vazio

Após criar a base canônica de `jogadores` e executar a lógica da 0010:

- tabela `jogadores` presente;
- 29 colunas totais: 24 do CREATE legado + 5 da 0010;
- `display_name`, `nome_real`, `idade_real`, `gosta_de_fazer` e `disponibilidade_detalhada` presentes;
- `user_version=0`;
- ledger ausente;
- quick/integrity OK;
- 0 violações FK.

## Testes de regressão

`schemaBasePrebootstrap.test.js` passa a exigir:

- 15 CREATEs canônicos iguais ao legacy;
- 15 bases criadas/presentes;
- 9 migrations transitórias;
- 5/5 targets da 0010 presentes antes do legacy;
- rollback remove também `jogadores`;
- boots formais continuam terminando em v10.

## Segurança

- nenhum `database/legacy.js` alterado;
- nenhuma migration/checksum alterado;
- nenhuma das outras 45 colunas de `jogadores` foi promovida;
- nenhum banco live aberto/escrito;
- nenhum deploy/restart/reload;
- PM2/Mudzap intocados;
- Raid/Squads intocados.
