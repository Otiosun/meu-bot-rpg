# FASE 2 — cleanup dos 10 ensureColumn de traços canônicos

Data: 18/08/2026

## Pré-condições fechadas

- migration `0014_character_trait_columns` mergeada no PR #250;
- pre-bootstrap canônico estendido até a 0014 no PR #251;
- `jogadores` já é tabela-base canônica;
- as dez colunas de traços são garantidas antes do legacy em banco ainda não adotado.

## Escopo

Remover exatamente dez chamadas `ensureColumn()` de `jogadores`:

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

Legacy canônico antes do cleanup:

`37cb6a38c910b5a84f131f0828f2171b350cc6a5`

O blob pós-cleanup será calculado no clone canônico durante o transporte mecânico e confirmado novamente no remoto.

Diff obrigatório:

- 0 adições;
- 10 deleções;
- 25 chamadas `ensureColumn()` ainda permanecem no legacy.

## Auditor pós-cleanup

`schemaBaseConsolidationAudit` passa a cobrir migrations `0002→0014`:

- totalTargets = 100;
- basePresent = 28;
- baseMissing = 72;
- legacyEnsurePresent = 0.

As dez colunas da 0014 não fazem parte do `CREATE jogadores` base. As 13 dependências pós-DDL já protegidas permanecem inalteradas; não há índice ou normalização de startup adicional dependente especificamente dos dez campos de traços.

## Prova de equivalência

Em cópia do snapshot real, as dez chamadas `ensureColumn()` são no-op porque as colunas já existem.

Resultado preservado:

- 623 jogadores;
- 0 alteração de schema;
- fingerprint de schema idêntico;
- digest lógico das dez colunas idêntico;
- `quick_check=ok`;
- `integrity_check=ok`;
- 0 violações FK.

Coerência valor/key permanece idêntica:

- `aptidao_comum`: 0 key sem valor, 0 valor sem key, 189 pares preenchidos;
- `marca_comum`: 0 key sem valor, 0 valor sem key, 200 pares preenchidos;
- `aptidao_rara`: 0 key sem valor, 0 valor sem key, 32 pares preenchidos;
- `marca_rara`: 0 key sem valor, 0 valor sem key, 21 pares preenchidos;
- `anomalia`: 0 key sem valor, 1 valor textual sem key, 9 pares preenchidos.

O caso legado de `anomalia` textual sem key não é alterado nem reinterpretado.

## Fora do escopo

Continuam no legacy depois deste cleanup:

- `tentativas_especiais`;
- `roll_sacrifice_used`;
- `roll_sacrifice_used_at`;
- bloco de história/estado de jogo;
- ensures de Squads;
- ensure de Raid.

## Segurança

- cleanup estritamente mecânico;
- nenhum `UPDATE`, backfill ou normalização;
- nenhum banco Windows live aberto/escrito;
- nenhum deploy/restart/reload;
- PM2 e Mudzap intocados;
- Raid/Squads intocados.
