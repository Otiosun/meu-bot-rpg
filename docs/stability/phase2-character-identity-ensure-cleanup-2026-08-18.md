# FASE 2 — cleanup dos 8 ensureColumn da identidade do personagem

Data: 18/08/2026

## Pré-condições

- migration `0011_character_identity_columns` mergeada no PR #241;
- pre-bootstrap canônico estendido até a 0011 no PR #242;
- `jogadores` já é tabela-base canônica;
- snapshot real e banco pré-bootstrap v11 comprovam presença das oito colunas antes do legacy.

## Escopo

Remover somente oito chamadas `ensureColumn()` de `jogadores`:

- `personagem_nome`;
- `personagem_idade`;
- `personagem_genero`;
- `numero_roll_escolhido`;
- `ficha_status`;
- `ultima_recepcao_em`;
- `familia_key`;
- `magia_key`.

Nenhuma coluna de aparência/moderação, traços, história/estado de jogo, Squads ou Raid entra neste cleanup.

## SHA e diff mecânico

Legacy canônico antes:

`54afe1349097179993a5f212828933b71e21a01c`

Candidato após somente as oito deleções:

`60a27527965139e19cd0b3523ae316426eb832b4`

Gate esperado:

- 0 adições;
- 8 deleções;
- 46 chamadas `ensureColumn()` permanecem.

## Auditor pós-cleanup

Cobertura migrada passa de 71 para 79 targets:

- `totalTargets=79`;
- `basePresent=28`;
- `baseMissing=51`;
- `legacyEnsurePresent=0`.

As oito colunas da 0011 não estão no `CREATE TABLE jogadores` base e por isso aumentam `baseMissing`; sua garantia pré-legacy vem da migration transitória 0011 no pre-bootstrap.

As dependências pós-DDL já auditadas permanecem inalteradas; não foi identificada nova dependência de índice/normalização ligada diretamente a estas oito colunas.

## Prova original × cleaned

### Banco pré-bootstrap v11

Original e candidato foram executados separadamente sobre a mesma base pré-bootstrap v11:

- 68 tabelas em ambos;
- fingerprint idêntico: `8a94d507ec4104955f3319d6992082ca02903098ad98a48ace14d287cf942948`;
- mesmas contagens;
- `jogadores`: 0 registros em ambos;
- digest idêntico;
- `quick_check=ok`;
- `integrity_check=ok`;
- 0 violações FK.

### Snapshot real FASE 0

Original e candidato foram executados separadamente sobre cópias do snapshot real:

- 169 tabelas em ambos;
- 471.430 linhas em ambos;
- 623 jogadores em ambos;
- fingerprint idêntico: `39050767cc8bae6d864b6c59bbf4d7a552ea892ee26e8529c4f43966eee979a1`;
- digest lógico de `jogadores` idêntico: `72b548004b68215dbaa70159b309b5a6e17b452f7a758e02295f7afc626619e1`;
- 0 mudanças de contagem;
- `quick_check=ok`;
- `integrity_check=ok`;
- 0 violações FK.

Nenhum valor pessoal foi exposto; a comparação usou somente digest e contagens.

## Segurança

- cleanup estritamente mecânico;
- nenhum dado é atualizado;
- nenhum índice, seed, normalização ou CREATE TABLE é removido;
- nenhum banco Windows live aberto/escrito;
- nenhum deploy/restart/reload;
- PM2/Mudzap intocados;
- Raid/Squads permanecem congelados.
