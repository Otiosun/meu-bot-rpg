# FASE 2 — migration 0021: Raid V2 columns

Data: 19/08/2026

Base canônica: db1a5d63e120c2a4ccc6b58ab2520120f4e23d40 (PR #271 fechado antes desta migration).

## Objetivo

Formalizar somente a camada de oito colunas V2 persistidas em `clover_raids`, sem promover ainda a 0021 ao pre-bootstrap e sem remover os `ensureColumn()` de `raidV2Schema.js`.

## Escopo estrutural exato

- `category_key`
- `category_label`
- `scope_type`
- `scope_player_id`
- `scope_squad_key`
- `month_key`
- `counts_monthly`
- `monthly_limit`
- índice `idx_clover_raids_monthly_scope`

## Normalização formal

- Raid V1 sem `category_key`: vira V2 não-retroativa, `evento_especial`, escopo global, `counts_monthly=0`;
- o campo legado `category` é preservado nesse primeiro backfill;
- `month_key` é calculado de timestamp SQLite interpretado como UTC para `America/Sao_Paulo`;
- timestamp não determinístico falha fechado, nunca usa a data atual;
- `missao_desenvolvimento` player-scoped é unificada em `saga_pessoal`;
- categoria mensal global com `counts_monthly=0` é normalizada para `evento_especial`;
- estado V2 parcial com categoria/escopo/mês incoerente falha fechado.

## Fora de escopo obrigatório

- `clover_raid_participants.finalization_*`;
- rebuild/expansão de `clover_raid_rewards`;
- `clover_raid_monthly_reservations`;
- `clover_raid_monthly_ledger`;
- finalização, rewards, PA, PM, caixas;
- promoção da 0021 ao pre-bootstrap;
- cleanup dos `ensureColumn()` de `raidV2Schema.js`;
- live, banco vivo, PM2 e Mudzap.

## Evidência do snapshot FASE 0

Snapshot auditado read-only:
- SHA-256 original: `45952a05fd9aee1518bb6e575029681f405fd55e4df9981fadbcb78c3a0f1ed6`;
- `PRAGMA quick_check = ok`;
- `foreign_key_check = 0`;
- 6 Raids;
- as 8 colunas V2 já estão presentes;
- 5 Raids estão em `evento_especial/global/counts=0`;
- 1 Raid está em `missao_esquadrao/squad/mephistopolis/counts=1/limit=2`;
- `clover_raid_monthly_reservations` existe com 1 registro liberado;
- `clover_raid_monthly_ledger` existe e está vazio;
- participantes já possuem a camada de finalização;
- rewards já possui estado próprio.

Conclusão: essas camadas existem de forma independente; a 0021 não deve tocar finalização, rewards ou tabelas mensais.

## Ordem posterior

1. merge da migration formal 0021;
2. promoção 0021 ao pre-bootstrap em slice separado;
3. prova de cobertura;
4. cleanup separado dos oito `ensureColumn()` runtime de V2;
5. somente depois partir para finalização/rewards/mensal como slices próprios.
