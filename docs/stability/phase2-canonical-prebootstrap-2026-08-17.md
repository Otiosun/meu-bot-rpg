# FASE 2 — pre-bootstrap canônico antes do legacy

Data: 17/08/2026

## Objetivo

Desbloquear a futura remoção de `ensureColumn()` sem quebrar bancos antigos ainda não adotados e sem gravar ledger/fingerprint antes do bootstrap legado terminar.

## Desenho

Para banco ainda não adotado (`user_version=0`, ledger ausente/vazio), no caminho real de produção:

1. abrir conexão isolada;
2. criar/idempotentemente garantir 13 tabelas-base canônicas extraídas do `database/legacy.js` atual;
3. executar transitoriamente apenas migrations schema-safe `0002→0008` dentro de `BEGIN IMMEDIATE`;
4. **não criar ledger e não alterar `PRAGMA user_version`**;
5. fechar conexão de pre-bootstrap;
6. executar `database/legacy.js` normalmente (índices, seeds, normalizações e restante do schema);
7. só então executar `runCloverSchemaMigrations`, formalizando ledger `0001→0008` e fingerprints sobre o schema final.

Migrations futuras não entram automaticamente no pre-bootstrap: há allowlist explícita de keys `0002→0008`.

Custom legacy mantém comportamento antigo por padrão. O caminho canônico só é habilitado para custom fixture quando `canonicalPrebootstrap: true` é solicitado explicitamente.

## Catálogo-base

`schemaBaseCatalog.js` contém 13 `CREATE TABLE IF NOT EXISTS` para as tabelas tocadas pelas 53 colunas já migradas:

- `clover_character_stats`
- `clover_box_openings`
- `clover_inventory_reservations`
- `clover_consumable_uses`
- `player_onboarding`
- `pending_magic_confirmations`
- `group_settings`
- `clover_market_listings`
- `clover_weekly_npc_requests`
- `clover_quick_evaluations`
- `player_rolls`
- `clover_item_templates`
- `clover_inventory_items`

Teste compara os 13 corpos SQL com o `database/legacy.js` canônico e falha em drift.

## Gate local

Suíte completa de migrations + pre-bootstrap: **47/47 PASS**.

Inclui:
- catálogo-base = 13 CREATEs do legacy atual;
- banco vazio recebe 13 bases + 53 colunas sem ledger/user_version;
- segunda passagem é idempotente;
- rollback transacional remove inclusive tabelas criadas na tentativa;
- estado `user_version != 0` sem adoção falha fechado;
- integração `database.js → prebootstrap → legacy → ledger formal`;
- bootstrap real completo em diretório vazio: 69 tabelas, ledger `[1..8]`, `user_version=8`, quick/integrity OK, 0 FK violations;
- upgrade real de schema antigo sem ledger preserva dados preexistentes;
- todos os testes anteriores de migration 0001→0008 continuam passando.

## Snapshot real

Cópia descartável do snapshot FASE 0:

- SHA origem e cópia: `45952a05fd9aee1518bb6e575029681f405fd55e4df9981fadbcb78c3a0f1ed6`;
- antes: 169 tabelas, 471.430 linhas, `user_version=0`, sem ledger, fingerprint `39050767cc8bae6d864b6c59bbf4d7a552ea892ee26e8529c4f43966eee979a1`;
- após pre-bootstrap transitório: 169 tabelas, 471.430 linhas, `user_version=0`, sem ledger, fingerprint idêntico;
- 0 contagens alteradas;
- quick_check=ok;
- integrity_check=ok;
- 0 FK violations;
- segunda passagem: no-op/fingerprint idêntico.

## Segurança

- nenhum `database/legacy.js` alterado;
- nenhum migration engine/catálogo 0001→0008 alterado;
- nenhum live DB/PM2/Mudzap/deploy;
- pre-bootstrap não grava ledger nem user_version;
- tudo que altera schema transitório ocorre em uma transação com rollback.

## Próximo gate

Depois deste pre-bootstrap, a remoção dos 53 `ensureColumn()` ainda fica bloqueada até auditoria de **bypass do wrapper**: qualquer callsite que importe/execute `database/legacy.js` diretamente precisa ser eliminado ou explicitamente classificado. Só então a limpeza mecânica do legacy pode ser segura.
