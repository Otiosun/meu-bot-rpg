# FASE 2 — promover 0021 Raid V2 ao pre-bootstrap

Data: 19/08/2026

Base canônica: 22a1d29de86cd67b2e959936e1fcbaf90619ead6 (PR #272).

## Objetivo

Adicionar 0021_raid_v2_columns à seleção canônica de migrations transitórias executadas antes do legacy em banco ainda não adotado.

## Decisão estrutural

O schemaBaseCatalog permanece byte-for-byte inalterado e continua reproduzindo os 18 CREATE TABLE do legacy. As oito colunas V2 não são embutidas no CREATE base; elas são adicionadas pela migration 0021 durante o pre-bootstrap.

Isso preserva a separação entre:
- CREATE base canônico do legacy;
- migrations transitórias de compatibilidade;
- adoção formal posterior pelo ledger/user_version.

## Gates

- DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS termina em 0021_raid_v2_columns;
- 20 migrations transitórias, 0002→0021;
- banco vazio termina com as 8 colunas V2 e índice mensal;
- Raid V1 legado vira V2 evento_especial/global não retroativo, preservando campos legados;
- ledger continua ausente e user_version permanece 0 durante pre-bootstrap;
- finalização, rewards e tabelas mensais permanecem fora;
- raidV2Schema mantém os 8 ensureColumn runtime nesta etapa.

## Fora de escopo

- cleanup dos 8 ensures runtime;
- alteração do schemaBaseCatalog;
- finalização;
- rewards;
- monthly reservations/ledger;
- live DB, PM2 e Mudzap.

Próximo slice: prova de cobertura V2 para permitir cleanup separado dos 8 ensures runtime.
