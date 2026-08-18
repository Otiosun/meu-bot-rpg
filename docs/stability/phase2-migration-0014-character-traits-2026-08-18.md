# FASE 2 — migration 0014 de traços canônicos do personagem

Data: 18/08/2026

## Escopo

A migration `0014_character_trait_columns` formaliza somente dez colunas de traços em `jogadores`:

- `aptidao_comum TEXT DEFAULT '-'`
- `aptidao_comum_key TEXT DEFAULT NULL`
- `marca_comum TEXT DEFAULT '-'`
- `marca_comum_key TEXT DEFAULT NULL`
- `aptidao_rara TEXT DEFAULT '-'`
- `aptidao_rara_key TEXT DEFAULT NULL`
- `marca_rara TEXT DEFAULT '-'`
- `marca_rara_key TEXT DEFAULT NULL`
- `anomalia TEXT DEFAULT '-'`
- `anomalia_key TEXT DEFAULT NULL`

Ficam deliberadamente fora deste lote:

- `tentativas_especiais`
- `roll_sacrifice_used`
- `roll_sacrifice_used_at`

Esses três campos representam estado de tentativa/consumo e serão tratados em uma migration separada.

## Semântica

A 0014 é estritamente DDL idempotente:

- usa somente `addColumnIfMissing`;
- não executa `UPDATE`;
- não executa backfill;
- não deriva keys;
- não normaliza nomes de traço;
- não altera nenhum writer/read-model de personagem.

Checksum canônico esperado:

`38cf9af135b931ff7a61e889e6c8b29d59ddaeb8da3ec62e8338af7007d3aaaa`

## Prova em schema antigo

Em banco descartável contendo `jogadores` sem os dez campos:

- primeira passagem adicionou exatamente 10/10 colunas;
- tipos/defaults resultantes coincidiram com o legacy;
- segunda passagem adicionou 0/10 colunas.

## Prova no snapshot real

A prova foi executada somente em cópia do snapshot FASE 0; o original não foi mutado.

Resultado:

- 623 jogadores antes e depois;
- 0 colunas adicionadas porque as dez já existem;
- fingerprint de schema idêntico;
- digest lógico das dez colunas idêntico;
- `quick_check=ok`;
- `integrity_check=ok`;
- 0 violações de FK.

Coerência valor/key observada e preservada:

- `aptidao_comum`: 0 key sem valor, 0 valor sem key, 189 pares preenchidos;
- `marca_comum`: 0 key sem valor, 0 valor sem key, 200 pares preenchidos;
- `aptidao_rara`: 0 key sem valor, 0 valor sem key, 32 pares preenchidos;
- `marca_rara`: 0 key sem valor, 0 valor sem key, 21 pares preenchidos;
- `anomalia`: 0 key sem valor, 1 valor textual sem key, 9 pares preenchidos.

O único caso de `anomalia` textual sem `anomalia_key` é estado preexistente. A migration preserva esse estado e não tenta inferir ou preencher a key.

## Fronteira de bootstrap

Neste PR:

- o catálogo formal passa de 0013 para 0014;
- o boot formal termina em `user_version=14` e ledger `[1..14]`;
- o pre-bootstrap transitório permanece deliberadamente limitado a `0002→0013`.

A promoção da 0014 para o pre-bootstrap será um gate separado. Somente depois desse gate será permitido preparar a remoção dos dez `ensureColumn()` equivalentes do `database/legacy.js`.

## Segurança

- nenhum `database/legacy.js` alterado neste PR;
- nenhuma remoção de `ensureColumn()` neste PR;
- nenhum banco Windows live aberto ou escrito;
- nenhum deploy/restart/reload;
- PM2 e Mudzap intocados;
- Raid e Squads intocados.
