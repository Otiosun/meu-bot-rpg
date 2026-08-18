# FASE 2 — cleanup dos 2 ensureColumn de avatar do site

Data: 18/08/2026

## Pré-condições fechadas

- migration `0013_site_profile_image_columns` mergeada no PR #247;
- pre-bootstrap canônico estendido até a 0013 no PR #248;
- `jogadores` já é tabela-base canônica;
- as duas colunas são garantidas antes do legacy em banco ainda não adotado;
- `profileImageService` permanece o writer do avatar e não será alterado.

## Escopo

Remover exatamente duas chamadas `ensureColumn()` de `jogadores`:

- `site_profile_image_data TEXT DEFAULT NULL`;
- `site_profile_image_updated_at TEXT DEFAULT NULL`.

Legacy antes do cleanup:

`fb731ebabc99b73e3caeb7034cfef2931e3d3292`.

O blob pós-cleanup será calculado no clone canônico durante o transporte mecânico e confirmado novamente no remoto.

Diff obrigatório:

- 0 adições;
- 2 deleções;
- 35 chamadas `ensureColumn()` ainda permanecem no legacy.

## Auditor pós-cleanup

`schemaBaseConsolidationAudit` passa a cobrir migrations `0002→0013`:

- totalTargets = 90;
- basePresent = 28;
- baseMissing = 62;
- legacyEnsurePresent = 0.

As duas colunas da 0013 não fazem parte do `CREATE jogadores` base.

Não há índice ou normalização pós-DDL no `legacy.js` dependente especificamente de `site_profile_image_*`. O writer de runtime `profileImageService` não é DDL de startup e permanece fora deste cleanup. As 13 dependências pós-DDL já protegidas continuam inalteradas.

## Prova de equivalência original × cleaned

Duas cópias descartáveis do snapshot real foram comparadas:

- cópia A executa as duas chamadas `ensureColumn()` originais;
- cópia B omite somente essas duas chamadas.

Resultado idêntico:

- 169 tabelas;
- 623 jogadores;
- 84 colunas em `jogadores`;
- digest lógico completo de `jogadores` idêntico;
- 97 jogadores com `site_profile_image_data` não vazio;
- 100 com `site_profile_image_updated_at` não vazio;
- 0 com imagem sem timestamp;
- 3 com timestamp sem imagem;
- fingerprint de schema idêntico;
- `quick_check=ok`;
- `integrity_check=ok`;
- 0 violações FK;
- `user_version=0`.

Os 3 registros com timestamp sem imagem são estado preexistente e não são alterados ou reinterpretados por este cleanup.

## Segurança

- cleanup estritamente mecânico;
- nenhum `UPDATE`, backfill ou normalização;
- `profileImageService` não é alterado;
- `appearanceManager` não é alterado;
- nenhum banco Windows live aberto/escrito;
- nenhum deploy/restart/reload;
- PM2/Mudzap intocados;
- Raid/Squads intocados.
