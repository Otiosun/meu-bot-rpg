# FASE 2 — cleanup dos 9 ensureColumn de moderação de aparência

Data: 18/08/2026

## Pré-condições fechadas

- migration `0012_appearance_moderation_columns` mergeada no PR #244;
- pre-bootstrap canônico estendido até a 0012 no PR #245;
- `jogadores` já é tabela-base canônica;
- as nove colunas são garantidas antes do legacy em banco ainda não adotado;
- as duas colunas de avatar do site permanecem fora deste cleanup.

## Escopo

Remover exatamente nove chamadas `ensureColumn()` de `jogadores`:

- `personagem_aparencia`;
- `personagem_aparencia_normalizada`;
- `personagem_aparencia_status`;
- `personagem_aparencia_motivo`;
- `personagem_aparencia_image_path`;
- `personagem_aparencia_image_message_id`;
- `personagem_aparencia_approved_by`;
- `personagem_aparencia_approved_at`;
- `personagem_aparencia_updated_at`.

`site_profile_image_data` e `site_profile_image_updated_at` devem permanecer no legacy neste gate.

Legacy antes do cleanup:
`60a27527965139e19cd0b3523ae316426eb832b4`.

O blob pós-cleanup será calculado no clone canônico durante o transporte mecânico e confirmado pelo diff do GitHub antes do merge.

Diff obrigatório:

- 0 adições;
- 9 deleções;
- 37 chamadas `ensureColumn()` ainda permanecem no legacy.

## Auditor pós-cleanup

`schemaBaseConsolidationAudit` passa a cobrir migrations `0002→0012`:

- totalTargets = 88;
- basePresent = 28;
- baseMissing = 60;
- legacyEnsurePresent = 0.

As nove colunas da 0012 não fazem parte do `CREATE jogadores` base.

As dependências pós-DDL obrigatórias passam de 11 para 13, acrescentando:

- `idx_jogadores_aparencia_normalizada`;
- `idx_jogadores_jogo_status`.

O segundo índice ainda combina `personagem_aparencia_status` com colunas de história/estado de jogo não migradas; por isso ele deve permanecer protegido enquanto esses ensures ainda existirem.

## Prova de equivalência do delta

Duas cópias descartáveis do snapshot real foram comparadas:

- cópia A executa as nove chamadas `ensureColumn()` originais;
- cópia B omite somente essas nove chamadas.

Resultado idêntico nas duas:

- 169 tabelas;
- 623 jogadores;
- 84 colunas em `jogadores`;
- digest lógico completo de `jogadores` idêntico;
- estados de aparência: 210 `approved`, 409 `pending`, 4 `rejected`;
- 0 estados terminais sem `approved_by`;
- 0 estados terminais sem `approved_at`;
- 0 pendentes com `approved_by` preenchido;
- `quick_check=ok`;
- `integrity_check=ok`;
- 0 violações FK;
- `user_version=0`.

Como o pre-bootstrap v12 garante as nove colunas antes do legacy, as chamadas removidas são no-op no caminho canônico.

## Segurança

- cleanup estritamente mecânico;
- nenhum `UPDATE`, backfill ou normalização de estado de aparência;
- workflow `appearanceManager` não é alterado;
- avatar do site não é alterado;
- nenhum banco Windows live aberto/escrito;
- nenhum deploy/restart/reload;
- PM2/Mudzap intocados;
- Raid/Squads intocados.
