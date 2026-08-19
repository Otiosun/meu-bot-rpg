# FASE 2 — migration 0019 de Squads

Data: 18/08/2026

## Escopo

A migration `0019_squad_columns` formaliza somente as 8 colunas de compatibilidade legada de `clover_squads`:

- `group_id TEXT DEFAULT NULL`
- `phrase TEXT DEFAULT NULL`
- `captain_name TEXT DEFAULT NULL`
- `captain_player_id TEXT DEFAULT NULL`
- `vice_captain_player_id TEXT DEFAULT NULL`
- `description_synced_at TEXT DEFAULT NULL`
- `description_sync_status TEXT DEFAULT NULL`
- `description_sync_error TEXT DEFAULT NULL`

## Base canônica

`clover_squads` passa a integrar `MIGRATED_BASE_TABLES` com o CREATE canônico idêntico ao `database/legacy.js`.

Isso é necessário porque `addColumnIfMissing` falha fechado quando a tabela não existe. Em banco vazio, a base canônica cria a tabela completa. Em banco legado já existente, a futura promoção da 0019 ao pre-bootstrap poderá adicionar somente colunas ausentes antes do legacy.

## Semântica

A 0019 é DDL idempotente puro:

- usa somente `addColumnIfMissing`;
- não executa `UPDATE` ou backfill;
- não altera membros;
- não altera estrelas;
- não altera capitão/vice existentes;
- não altera vínculo de grupo existente;
- não altera status/erro/timestamp de sincronização existente;
- não toca Raid.

Checksum canônico:

`7353f8ca72960f12c56bcf6619ee62e3dad497edd1d355c57a16e5e48982426c`

## Fronteira de bootstrap

Neste PR:

- catálogo formal passa de 0018 para 0019;
- `clover_squads` passa de 15 para 16 bases canônicas;
- o pre-bootstrap transitório continua deliberadamente em `0002→0018`;
- os 8 `ensureColumn()` de Squads permanecem no legacy;
- o único `ensureColumn()` de Raid permanece congelado.

A 0019 só poderá entrar no pre-bootstrap em PR separado, depois da prova de schema antigo. Só depois disso os 8 ensures de Squads poderão ser removidos mecanicamente.

## Segurança

- `database/legacy.js` não é alterado;
- nenhum ensure é removido;
- nenhum banco Windows live é aberto;
- nenhum deploy/restart/reload;
- PM2 e Mudzap intocados;
- Raid intocado.
