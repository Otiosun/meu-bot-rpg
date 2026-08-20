# FASE 2 — promover 0022 Raid participant finalization ao pre-bootstrap

Data: 20/08/2026

Base canônica: b0e8b6c67f44e6ce987d2f87ff02350d2dcf32fd (PR #276).

## Objetivo

Adicionar `0022_raid_participant_finalization` à seleção canônica de migrations transitórias executadas antes do legacy em banco ainda não adotado.

## Decisão estrutural

O `schemaBaseCatalog` permanece inalterado e continua reproduzindo os CREATE TABLE do legacy. As quatro colunas de finalização permanecem responsabilidade da migration 0022 durante o pre-bootstrap.

Isso preserva a separação entre:
- CREATE base canônico;
- migrations transitórias de compatibilidade;
- adoção formal posterior por ledger/user_version.

## Gates

- `DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS` termina em `0022_raid_participant_finalization`;
- 21 migrations transitórias, 0002→0022;
- banco vazio termina com as quatro colunas e o índice `idx_clover_raid_participant_finalization`;
- índice exato em `(raid_id, finalization_status, status, id)`;
- Raid legada mantém dados antigos e recebe `finalization_status='pending'`, sem reclassificação retroativa;
- `completed+pending` continua preservado e a compatibilidade `eligible_legacy` permanece no runtime;
- ledger continua ausente e `user_version` permanece 0 durante pre-bootstrap;
- os quatro runtime `ensureColumn()` permanecem nesta etapa;
- rewards, mensal, PA/PM/boxes e Inventory ficam fora.

## Fora de escopo

- remover runtime ensures;
- alterar auditor de cobertura para absorver 0022;
- rebuild de rewards;
- progresso mensal;
- corrigir o bug basal de fixture Inventory/template_key;
- live DB, runtime, PM2 ou Mudzap.

Próximo slice: prova de cobertura 1:1 dos quatro runtime ensures antes do cleanup separado.
