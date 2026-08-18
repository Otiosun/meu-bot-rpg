# FASE 2 — migration 0016 de história/narrativa

Data: 18/08/2026

## Escopo

A migration `0016_story_state_columns` formaliza somente oito colunas de história em `jogadores`:

- `historia_status TEXT DEFAULT 'pendente'`
- `historia_status_updated_at TEXT DEFAULT NULL`
- `historia_aprovada_at TEXT DEFAULT NULL`
- `historia_aprovada_by TEXT DEFAULT NULL`
- `historia_pv_sent_at TEXT DEFAULT NULL`
- `historia_motivo TEXT DEFAULT NULL`
- `gancho_narrativo TEXT DEFAULT '-'`
- `historias_extras TEXT DEFAULT '[]'`

Ficam deliberadamente fora deste lote:

- `jogo_status`
- `jogo_liberado_at`
- `jogo_liberado_by`
- `jogo_bloqueio_motivo`
- `patente`

## Semântica

A 0016 é estritamente DDL idempotente:

- usa somente `addColumnIfMissing`;
- não executa `UPDATE`;
- não aprova nem nega história;
- não altera motivo ou timestamps;
- não normaliza `gancho_narrativo`;
- não reescreve `historias_extras`;
- não altera o comando/serviço que libera ou bloqueia jogo.

Checksum canônico esperado do source versionado:

`dde11c5e1b4a302ab8f30182bda61a979c6da4000e7f4976d95eec8db6d5ccfd`

## Prova em schema antigo

Em banco descartável contendo `jogadores` sem os oito campos:

- primeira passagem adiciona exatamente 8/8 colunas;
- tipos/defaults coincidem com o legacy;
- segunda passagem é no-op;
- tabela `jogadores` ausente falha fechado e preserva ledger/user_version em v15.

## Prova no snapshot FASE 0

Executada somente em cópia/read-only do snapshot; original não foi mutado.

Estado observado e preservado:

- 623 jogadores;
- `historia_status`: 599 `pendente`, 24 `aprovada`;
- 0 histórias aprovadas sem `historia_aprovada_at`/`historia_aprovada_by`;
- 0 histórias não aprovadas carregando metadata de aprovação;
- `historias_extras`: 623 valores JSON válidos, 0 inválidos;
- as oito colunas já existem, portanto o delta formal é schema-no-op;
- nenhum backfill é necessário ou permitido.

Saúde do snapshot:

- `quick_check=ok`;
- `integrity_check=ok`;
- 0 violações de FK.

## Fronteira de bootstrap

Neste PR:

- catálogo formal passa de 0015 para 0016;
- boot formal termina em `user_version=16` e ledger `[1..16]`;
- pre-bootstrap transitório permanece deliberadamente em `0002→0015`.

A promoção da 0016 para o pre-bootstrap será um gate separado. Somente depois será permitido remover os oito `ensureColumn()` equivalentes do legacy.

## Segurança

- `database/legacy.js` não é alterado neste PR;
- nenhum `ensureColumn()` é removido neste PR;
- nenhum writer/read-model de história ou jogo é alterado;
- nenhum banco Windows live é aberto/escrito;
- nenhum deploy/restart/reload;
- PM2 e Mudzap intocados;
- Raid e Squads intocados.
