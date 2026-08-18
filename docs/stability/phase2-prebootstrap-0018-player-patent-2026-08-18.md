# FASE 2 — pre-bootstrap canônico até a migration 0018

Data: 18/08/2026

## Objetivo

Promover somente `0018_player_patent_column` para a allowlist transitória executada antes do legacy em bancos ainda não adotados.

`jogadores` já é tabela-base canônica; não há mudança em `schemaBaseCatalog.js`.

## Mudança operacional

`DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS` passa de `0002→0017` para `0002→0018`.

O pre-bootstrap vazio passa a exigir:

- 15 tabelas-base;
- 17 migrations transitórias;
- `jogadores.patente` presente antes do legacy;
- ledger de migrations ausente;
- `PRAGMA user_version = 0`.

## Prova do delta 0018

Em schema descartável anterior sem `patente`:

- a coluna é adicionada exatamente uma vez;
- tipo/default coincidem com o legacy (`TEXT DEFAULT '-'`);
- segunda execução adiciona 0 colunas.

Em cópia do snapshot FASE 0:

- 623 jogadores preservados;
- 0 colunas adicionadas porque `patente` já existe;
- 622 valores `-` preservados;
- 1 valor `Capitão` preservado;
- fingerprint/digest lógico permanecem idênticos;
- `quick_check=ok`;
- `integrity_check=ok`;
- 0 violações de FK.

## Limites

- nenhum `UPDATE`, backfill, promoção ou rebaixamento;
- nenhum writer de progressão/economia alterado;
- nenhuma mudança em schema-base ou legacy;
- nenhum ensure removido neste PR.

Depois deste gate, todas as 13 colunas finais de `jogadores` cobertas por 0016/0017/0018 estão garantidas antes do legacy. O próximo passo é o cleanup mecânico conjunto dessas 13 linhas em `database/legacy.js`, preservando somente os 9 ensures ainda não migrados (8 Squads + 1 Raid).

## Segurança

Nenhum banco Windows live, deploy, restart/reload, PM2, Mudzap, Raid ou Squads é tocado por este PR.
