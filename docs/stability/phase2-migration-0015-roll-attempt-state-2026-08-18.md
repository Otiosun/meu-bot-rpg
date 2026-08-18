# FASE 2 — migration 0015 de estado de tentativas e sacrifício de roll

Data: 18/08/2026

## Escopo

A migration `0015_roll_attempt_state_columns` formaliza somente três colunas de `jogadores`:

- `tentativas_especiais TEXT DEFAULT '[]'`
- `roll_sacrifice_used INTEGER DEFAULT 0`
- `roll_sacrifice_used_at TEXT DEFAULT NULL`

Esse lote foi deliberadamente separado dos dez campos de traços da 0014 porque representa estado de tentativa/consumo, não conteúdo canônico do personagem.

## Semântica

A 0015 é DDL idempotente somente:

- usa `addColumnIfMissing`;
- não executa `UPDATE`;
- não consome tentativa;
- não reseta estado;
- não altera JSON de tentativas;
- não altera timestamp de sacrifício.

Checksum canônico esperado:

`3b43ca25e0c877db9aa37102c7cec08eefe84b7cfd3adbfcdf3f90e9d54a7519`

## Prova no snapshot real

Executada somente em cópia do snapshot FASE 0.

Resultado:

- 623 jogadores antes/depois;
- 0 colunas adicionadas porque o schema já está completo;
- fingerprint de schema idêntico;
- digest lógico de `tentativas_especiais`, `roll_sacrifice_used` e `roll_sacrifice_used_at` idêntico;
- 209 jogadores com `tentativas_especiais` não-vazio;
- 57 jogadores com `roll_sacrifice_used != 0`;
- os mesmos 57 com `roll_sacrifice_used_at` preenchido;
- 0 `used` sem timestamp;
- 0 timestamp sem `used`;
- 0 JSON inválido em `tentativas_especiais`;
- `quick_check=ok`;
- `integrity_check=ok`;
- 0 violações FK.

## Fronteira de bootstrap

Neste PR:

- catálogo formal passa de 0014 para 0015;
- boot formal termina em `user_version=15` e ledger `[1..15]`;
- pre-bootstrap transitório permanece deliberadamente em `0002→0014`.

A promoção da 0015 para o pre-bootstrap será um gate separado. Só então será permitido remover os três `ensureColumn()` equivalentes do legacy.

## Segurança

- nenhum `database/legacy.js` alterado;
- nenhum cleanup neste PR;
- nenhum backfill/reset de estado;
- nenhum banco Windows live aberto/escrito;
- nenhum deploy/restart/reload;
- PM2/Mudzap intocados;
- Raid/Squads intocados.
