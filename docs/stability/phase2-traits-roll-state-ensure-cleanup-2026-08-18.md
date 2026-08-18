# FASE 2 — cleanup combinado dos 13 ensureColumn de traços + estado de roll

Data: 18/08/2026

## Pré-condições fechadas

- migration `0014_character_trait_columns` mergeada no PR #250;
- pre-bootstrap canônico estendido até a 0014 no PR #251;
- migration `0015_roll_attempt_state_columns` mergeada no PR #252;
- pre-bootstrap canônico estendido até a 0015 no PR #253;
- `jogadores` já é tabela-base canônica;
- os 13 campos são garantidos antes do legacy em banco ainda não adotado.

## Escopo

Remover exatamente 13 chamadas `ensureColumn()` de `jogadores`.

Traços canônicos (10):

- `aptidao_comum`
- `aptidao_comum_key`
- `marca_comum`
- `marca_comum_key`
- `aptidao_rara`
- `aptidao_rara_key`
- `marca_rara`
- `marca_rara_key`
- `anomalia`
- `anomalia_key`

Estado de roll/tentativas (3):

- `tentativas_especiais`
- `roll_sacrifice_used`
- `roll_sacrifice_used_at`

Legacy canônico antes do cleanup:

`37cb6a38c910b5a84f131f0828f2171b350cc6a5`

O blob pós-cleanup será calculado no clone canônico durante o transporte mecânico e confirmado novamente no remoto.

Diff obrigatório:

- 0 adições;
- 13 deleções;
- 22 chamadas `ensureColumn()` ainda permanecem no legacy.

## Auditor pós-cleanup

`schemaBaseConsolidationAudit` passa a cobrir migrations `0002→0015`:

- totalTargets = 103;
- basePresent = 28;
- baseMissing = 75;
- legacyEnsurePresent = 0.

As 13 dependências pós-DDL já protegidas permanecem inalteradas. Não há índice ou normalização de startup adicional dependente especificamente destes 13 campos.

## Prova combinada no snapshot real

Executada somente em cópia do snapshot FASE 0.

Resultado:

- 623 jogadores antes/depois;
- 0 colunas adicionadas porque as 13 já existem;
- fingerprint de schema idêntico;
- digest lógico conjunto dos 13 campos idêntico;
- `quick_check=ok`;
- `integrity_check=ok`;
- 0 violações FK.

Estado de traços preservado:

- `aptidao_comum`: 189 pares valor/key preenchidos, 0 key órfã, 0 valor órfão;
- `marca_comum`: 200 pares, 0/0 órfãos;
- `aptidao_rara`: 32 pares, 0/0 órfãos;
- `marca_rara`: 21 pares, 0/0 órfãos;
- `anomalia`: 9 pares e 1 valor textual legado sem key, preservado sem inferência.

Estado de tentativas/sacrifício preservado:

- 209 jogadores com `tentativas_especiais` não-vazio;
- 57 com `roll_sacrifice_used != 0`;
- os mesmos 57 com `roll_sacrifice_used_at` preenchido;
- 0 `used` sem timestamp;
- 0 timestamp sem `used`;
- 0 JSON inválido em `tentativas_especiais`.

## Fora do escopo

Depois deste cleanup permanecem 22 ensures:

- 13 ligados a história/estado de jogo em `jogadores`;
- 8 de Squads;
- 1 de Raid.

Raid e Squads continuam congelados.

## Segurança

- cleanup estritamente mecânico;
- nenhum `UPDATE`, backfill, reset ou normalização;
- nenhum banco Windows live aberto/escrito;
- nenhum deploy/restart/reload;
- PM2 e Mudzap intocados;
- Raid/Squads intocados.
