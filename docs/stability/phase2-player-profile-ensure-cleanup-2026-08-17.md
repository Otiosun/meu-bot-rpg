# FASE 2 — cleanup dos 5 ensureColumn de perfil humano

Data: 17/08/2026

## Pré-condições fechadas

- migration `0010_player_profile_columns` mergeada no PR #237;
- pre-bootstrap canônico estendido até a 0010 no PR #238;
- `jogadores` é a 15ª tabela-base canônica;
- as cinco colunas são garantidas antes do legacy em banco ainda não adotado.

## Escopo

Remover exatamente cinco chamadas `ensureColumn()` de `jogadores`:

- `display_name`;
- `nome_real`;
- `idade_real`;
- `gosta_de_fazer`;
- `disponibilidade_detalhada`.

Nenhuma das outras 45 colunas de `jogadores` é removida neste gate.

Legacy antes do cleanup:
`3d22dc4e654c8ccf7e3f7ebf0eba72d33a4191ea`.

Legacy candidato:
`54afe1349097179993a5f212828933b71e21a01c`.

Diff esperado:

- 0 adições;
- 5 deleções;
- 54 chamadas `ensureColumn()` ainda permanecem no legacy.

## Auditor pós-cleanup

`schemaBaseConsolidationAudit` passa a cobrir migrations `0002→0010`:

- totalTargets = 71;
- basePresent = 28;
- baseMissing = 43;
- legacyEnsurePresent = 0.

As cinco colunas da 0010 não fazem parte do `CREATE jogadores` base, por isso aumentam `baseMissing` de 38 para 43. Não há novo índice ou normalização pós-DDL dependente dessas cinco colunas; as 11 dependências já auditadas permanecem obrigatórias.

## Prova dinâmica original × cleaned

### Banco pré-bootstrapped até a 0010

- 68 tabelas em ambos;
- schema fingerprint idêntico: `5aad5a6a59f157a8cb995aafd46e1439764393f0694787bb8f7da27b04a6dc34`;
- contagens idênticas;
- jogadores idêntico;
- quick_check=ok;
- integrity_check=ok;
- 0 violações FK.

### Snapshot real FASE 0

- 169 tabelas em ambos;
- 471.430 linhas em ambos;
- 623 jogadores em ambos;
- schema fingerprint idêntico: `39050767cc8bae6d864b6c59bbf4d7a552ea892ee26e8529c4f43966eee979a1`;
- digest lógico de `jogadores` idêntico: `72b548004b68215dbaa70159b309b5a6e17b452f7a758e02295f7afc626619e1`;
- nenhuma contagem alterada;
- quick_check=ok;
- integrity_check=ok;
- 0 violações FK.

## Segurança

- cleanup estritamente mecânico;
- nenhum valor pessoal de jogador exposto;
- nenhum banco Windows live aberto/escrito;
- nenhum deploy/restart/reload;
- PM2/Mudzap intocados;
- Raid/Squads intocados.
