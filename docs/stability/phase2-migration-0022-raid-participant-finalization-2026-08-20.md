# FASE 2 — migration 0022: Raid participant finalization

Data: 20/08/2026

Base canônica obrigatória: 11c441375b9bfaeb7d9e30fd24ce3a94654b2b88.

## Objetivo

Formalizar somente a camada de quatro colunas de revisão/finalização persistida em `clover_raid_participants`, sem retirar ainda os `ensureColumn()` runtime e sem absorver rewards ou progresso mensal.

## Escopo estrutural exato

- `finalization_status TEXT NOT NULL DEFAULT 'pending'`
- `finalization_note TEXT DEFAULT NULL`
- `finalized_by TEXT DEFAULT NULL`
- `finalized_at TEXT DEFAULT NULL`
- índice `idx_clover_raid_participant_finalization`
- índice em `(raid_id, finalization_status, status, id)`

Status persistidos reconhecidos:
- `pending`
- `eligible`
- `absent`
- `ineligible`

`removed`, `withdrawn` e `eligible_legacy` são estados derivados pelo runtime; não são novos valores persistidos desta migration.

## Regra de compatibilidade legada

A migration é deliberadamente não retroativa.

Em Raid já concluída, `participant.status='completed'` + `finalization_status='pending'` é preservado como está. O runtime atual interpreta esse par como `eligible_legacy` na leitura. A 0022 NÃO converte `pending` para `eligible`.

## Evidência do snapshot canônico FASE 0

Snapshot read-only:
- SQLite SHA-256: `45952a05fd9aee1518bb6e575029681f405fd55e4df9981fadbcb78c3a0f1ed6`;
- `PRAGMA quick_check = ok`;
- `foreign_key_check = 0`;
- 37 participantes;
- 5 `completed + eligible`;
- 20 `completed + pending`;
- 1 `removed + pending`;
- 11 `withdrawn + pending`;
- índice canônico já presente com as quatro colunas esperadas.

Uma simulação DDL-only sobre cópia do snapshot manteve o digest das 37 linhas inalterado e permaneceu com integridade OK.

## Validação fail-closed

A 0022:
- exige a tabela e as colunas-base `id`, `raid_id`, `player_id`, `status`;
- adiciona apenas os quatro targets quando faltarem;
- rejeita forma de coluna preexistente incompatível;
- aceita status armazenado que, após `trim/lowercase`, pertença ao domínio conhecido, mas NÃO o reescreve;
- rejeita status sem mapeamento explícito;
- cria o índice com `IF NOT EXISTS` e depois verifica a ordem real das colunas, impedindo que índice homônimo incorreto passe silenciosamente.

## Fora de escopo obrigatório

- qualquer backfill `pending -> eligible`;
- alteração de `raidFinalizationService.js`;
- remoção dos quatro `ensureColumn()` de `raidRewardSchema.js`;
- rebuild/expansão de `clover_raid_rewards`;
- PA, PM, caixas ou entrega de recompensas;
- `clover_raid_monthly_reservations`;
- `clover_raid_monthly_ledger`;
- promoção da 0022 ao pre-bootstrap;
- alteração do auditor de cobertura para incluir 0022;
- live, banco vivo, PM2 e Mudzap.

## Ordem posterior

1. merge da migration formal 0022;
2. promoção 0022 ao pre-bootstrap em slice separado;
3. coverage proof 1:1 dos quatro ensures runtime;
4. cleanup separado dos quatro ensures, preservando índice e handoffs de rewards/PA/stats;
5. somente depois partir para rewards em migration própria;
6. mensal permanece em slice posterior próprio.
