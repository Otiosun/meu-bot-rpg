# FASE 2 — migrations 0016→0018 de história, liberação de jogo e patente

Data: 18/08/2026

## Objetivo

Formalizar os 13 campos restantes de `jogadores` sem misturar responsabilidades no mesmo migration object:

### 0016 — `0016_history_workflow_columns` (8)

- `historia_status TEXT DEFAULT 'pendente'`
- `historia_status_updated_at TEXT DEFAULT NULL`
- `historia_aprovada_at TEXT DEFAULT NULL`
- `historia_aprovada_by TEXT DEFAULT NULL`
- `historia_pv_sent_at TEXT DEFAULT NULL`
- `historia_motivo TEXT DEFAULT NULL`
- `gancho_narrativo TEXT DEFAULT '-'`
- `historias_extras TEXT DEFAULT '[]'`

### 0017 — `0017_game_release_columns` (4)

- `jogo_status TEXT DEFAULT 'bloqueado'`
- `jogo_liberado_at TEXT DEFAULT NULL`
- `jogo_liberado_by TEXT DEFAULT NULL`
- `jogo_bloqueio_motivo TEXT DEFAULT NULL`

### 0018 — `0018_player_rank_column` (1)

- `patente TEXT DEFAULT '-'`

## Semântica

As três migrations são DDL idempotente somente:

- usam `addColumnIfMissing`;
- não executam `UPDATE`;
- não aprovam/rejeitam história;
- não enviam PV;
- não liberam/bloqueiam jogo;
- não reconciliam timestamps;
- não alteram patente/progressão.

Checksums canônicos:

- 0016: `f74e01eac6d576a7e551a1ff09a601ccb1701483b0718c90635366d871845fc4`
- 0017: `acdad5b4d4e808cddc16ebcb2778f62632ae0ca6ca46a646b2c3c0693cf8699b`
- 0018: `fcbe8f75561e7c40b1d372c3604d42e8350417f2f78b062464b7a32d6b5ffd7a`

## Prova no snapshot real

Executada somente em cópia do snapshot FASE 0.

- 623 jogadores preservados;
- as 13 colunas já existem, então as migrations são schema-no-op no snapshot;
- digest lógico conjunto dos 13 campos: `902285f173a83fb0cd7f0e3877929ee887d8fe223cbbdca6f47dfbbaae932f22`, preservado;
- quick/integrity OK;
- 0 violações FK.

Estado observado e deliberadamente preservado:

- história: 24 `aprovada`, 599 `pendente`;
- 0 histórias aprovadas sem `historia_aprovada_at`;
- 0 histórias aprovadas sem `historia_aprovada_by`;
- 23 `historias_extras` não-vazios e 0 JSON inválido;
- 23 `gancho_narrativo` não-default;
- jogo: 138 `liberado`, 405 `bloqueado`, 80 `arquivado`;
- 1 `liberado` sem `jogo_liberado_at`;
- 1 `liberado` sem `jogo_liberado_by`;
- 1 `bloqueado` ainda com `jogo_liberado_at`;
- 1 jogador com `patente` não-default.

Os três casos imperfeitos de estado de jogo são preexistentes e não são corrigidos neste trabalho.

## Testes adicionais

Este PR também corrige dois testes recém-adicionados da 0014/0015 que esperavam o código de erro `schema_table_missing`. O runtime canônico `addColumnIfMissing` usa `migration_precondition_failed`; somente a expectativa dos testes muda. Nenhum código de produção é alterado por essa correção.

## Fronteira de bootstrap

Neste PR:

- catálogo formal passa de 0015 para 0018;
- boot formal termina em `user_version=18` e ledger `[1..18]`;
- pre-bootstrap transitório permanece deliberadamente em `0002→0015`.

A promoção das migrations 0016→0018 ao pre-bootstrap será um gate separado. Só depois disso os 26 ensures de `jogadores` cobertos por 0014→0018 poderão ser removidos juntos.

## Segurança

- `database/legacy.js` não muda;
- zero cleanup neste PR;
- zero backfill/reconciliação;
- nenhum banco Windows live aberto/escrito;
- nenhum deploy/restart/reload;
- PM2/Mudzap intocados;
- Raid/Squads intocados.
