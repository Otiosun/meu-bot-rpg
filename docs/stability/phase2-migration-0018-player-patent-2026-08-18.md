# FASE 2 — migration 0018 de patente do jogador

Data: 18/08/2026

## Escopo

A migration `0018_player_patent_column` formaliza somente uma coluna de progressão/apresentação em `jogadores`:

- `patente TEXT DEFAULT '-'`

Ela fica isolada dos blocos 0016 (história) e 0017 (estado de jogo) porque é consumida por progressão, mercado/economia, apresentação e esquadrão, sem fazer parte do gate de aprovação/liberação.

## Semântica

A 0018 é DDL idempotente puro:

- usa somente `addColumnIfMissing`;
- não executa `UPDATE`;
- não promove nem rebaixa jogador;
- não normaliza nomes de patente;
- não altera salary/market/progression writers;
- não altera Squads ou Raid.

Checksum canônico do source versionado:

`94ac8996fac0d9be6ca0c4a0e09538ebd92a0aa4f6c2fe166976ee6885f562c2`

## Prova em schema antigo

- primeira passagem adiciona exatamente 1/1 coluna;
- tipo/default coincidem com o legacy (`TEXT DEFAULT '-'`);
- segunda aplicação é no-op;
- ausência de `jogadores` falha fechado e preserva ledger/user_version em v17.

## Snapshot FASE 0

Estado observado e deliberadamente preservado:

- 623 jogadores;
- 622 registros com `patente='-'`;
- 1 registro com `patente='Capitão'`;
- a coluna já existe, portanto a 0018 é schema-no-op no snapshot;
- nenhum dado deve ser promovido, rebaixado ou normalizado;
- `quick_check=ok`;
- `integrity_check=ok`;
- 0 violações de FK.

## Fronteira de bootstrap

Neste PR:

- catálogo formal passa de 0017 para 0018;
- boot formal termina em `user_version=18` e ledger `[1..18]`;
- pre-bootstrap transitório permanece deliberadamente em `0002→0017`.

A promoção da 0018 ao pre-bootstrap será um gate separado. Depois dela, os 13 ensures finais de `jogadores` (0016 + 0017 + 0018) poderão ser removidos num único cleanup mecânico.

## Segurança

- `database/legacy.js` não é alterado;
- nenhum ensure é removido neste PR;
- nenhum banco Windows live é aberto/escrito;
- nenhum deploy/restart/reload;
- PM2 e Mudzap intocados;
- Raid e Squads intocados.
