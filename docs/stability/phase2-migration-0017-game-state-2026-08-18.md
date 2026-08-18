# FASE 2 — migration 0017 de estado/acesso de jogo

Data: 18/08/2026

## Escopo

A migration `0017_game_state_columns` formaliza somente quatro colunas de acesso/estado de jogo em `jogadores`:

- `jogo_status TEXT DEFAULT 'bloqueado'`
- `jogo_liberado_at TEXT DEFAULT NULL`
- `jogo_liberado_by TEXT DEFAULT NULL`
- `jogo_bloqueio_motivo TEXT DEFAULT NULL`

`patente` permanece deliberadamente fora deste lote e será tratada isoladamente.

## Semântica

A 0017 é DDL idempotente puro:

- usa somente `addColumnIfMissing`;
- não executa `UPDATE`;
- não libera nem bloqueia player;
- não limpa timestamps/autor antigos;
- não altera motivo de bloqueio;
- não reconcilia estados arquivados;
- não altera `comandos/historiaJogo.js` nem qualquer writer/read-model.

Checksum canônico do source versionado:

`54951481617d6fe259a66402eb29218a89d3b35685cd1cbc91e65c4cf8c96734`

## Prova em schema antigo

- primeira passagem adiciona exatamente 4/4 colunas;
- tipos/defaults coincidem com o legacy;
- segunda passagem é no-op;
- ausência de `jogadores` falha fechado e preserva ledger/user_version em v16.

## Snapshot FASE 0

Estado observado e deliberadamente preservado:

- 623 jogadores;
- `jogo_status`: 405 `bloqueado`, 138 `liberado`, 80 `arquivado`;
- 1 player `liberado` com `jogo_liberado_at` ou `jogo_liberado_by` ausente;
- 78 players não-`liberado` com metadata histórica de liberação;
- 269 bloqueados sem motivo de bloqueio explícito.

Esses estados são preexistentes. A migration não tenta inferir intenção histórica ou normalizá-los.

As quatro colunas já existem no snapshot, portanto o delta formal é schema-no-op. Contagem, schema, digest dos quatro campos, `quick_check`, `integrity_check` e FK permanecem inalterados.

## Fronteira de bootstrap

Neste PR:

- catálogo formal passa de 0016 para 0017;
- boot formal termina em `user_version=17` e ledger `[1..17]`;
- pre-bootstrap transitório permanece deliberadamente em `0002→0016`.

A promoção de 0017 ao pre-bootstrap será um gate separado.

## Segurança

- nenhum `database/legacy.js` alterado;
- nenhum ensure removido;
- nenhum writer de jogo/história alterado;
- nenhum banco Windows live, deploy, restart/reload, PM2 ou Mudzap;
- Raid e Squads intocados.
