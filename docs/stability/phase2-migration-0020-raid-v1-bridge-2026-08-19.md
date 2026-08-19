# FASE 2 — migration 0020: bridge V1 de Raid

Data: 19/08/2026

## Origem histórica

O upgrade real de tabelas antigas de Raid existiu no commit `a84d1b36ff707b088824d3b309975c318886d7e4` (`fix(raid): migrar tabelas antigas de raid`).
Depois, o commit `4df0382fb0a35b9a9052376d2d131714f2da957b` removeu quase todo esse bridge do bootstrap legado e deixou apenas `salary_eligible`.

A migration 0020 formaliza somente a camada V1 não destrutiva necessária para convergir uma tabela pré-V1 com o CREATE moderno.

## Escopo

A 0020 versiona 20 colunas:

- 14 em `clover_raids`: `raid_key`, `category`, `description`, `location`, `owner_player_id`, `max_players`, `salary_eligible`, `rules_json`, `started_at`, `finalization_at`, `completed_at`, `cancelled_at`, `cancelled_by`, `cancellation_reason`;
- 6 em `clover_raid_participants`: `joined_via`, `removed_at`, `removed_by`, `removal_reason`, `snapshot_json`, `metadata_json`.

Ela não adiciona `code`, `slots` ou `created_by` a bancos modernos novos. Esses campos permanecem apenas onde já existem por herança pré-V1.

## Backfill

Em tabela pré-V1 compatível:

- `code` alimenta `raid_key`;
- `created_by` alimenta `owner_player_id` somente quando o campo moderno não existia antes;
- `slots` alimenta `max_players` somente quando o campo moderno não existia antes;
- `category` recebe `missao` quando vazia;
- `updated_at` é preservado e só recebe fallback se estiver nulo;
- `idx_clover_raids_raid_key` é garantido como índice único parcial.

## Fail-closed de status

Não existe no histórico uma tradução canônica documentada entre os status pré-V1 (`rascunho`, `aberta`, `fechada`, `avaliacao`, `simulada`, `aplicada`, `cancelada`) e o workflow moderno.

Por isso a 0020 não inventa mapeamento: se encontrar linhas com status fora do conjunto moderno, lança `raid_v1_status_mapping_required`. A infraestrutura de migrations executa a 0020 dentro de `BEGIN IMMEDIATE`; a falha reverte todo DDL antes de ledger/user_version.

## Deliberadamente fora da 0020

- colunas V2 (`category_key`, escopo, mês, limites mensais);
- normalizações V2;
- finalização de participantes;
- rebuild de `clover_raid_rewards`;
- tabelas mensais;
- promoção da 0020 ao pre-bootstrap;
- remoção do último `ensureColumn` de Raid.

Essas camadas serão tratadas separadamente para manter rollback e prova de compatibilidade auditáveis.

## Segurança operacional

- `database/legacy.js` permanece intocado;
- pre-bootstrap continua em 0019;
- o único `ensureColumn` real do legacy continua sendo `clover_raids.salary_eligible`;
- live/DB/PM2/Mudzap/Raid runtime não são acessados.
