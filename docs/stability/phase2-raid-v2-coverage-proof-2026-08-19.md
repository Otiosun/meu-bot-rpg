# FASE 2 — prova de cobertura Raid V2 antes do cleanup runtime

Data: 19/08/2026

Base canônica: 32b7e965d1f2cae454456d47f4502a6bd06e3c7f (PR #273).

## Objetivo

Provar formalmente que os oito ensureColumn de Raid V2 ainda presentes em raidV2Schema.js são redundância estrutural coberta pela migration 0021 e pelo pre-bootstrap canônico, sem removê-los neste slice.

## Cobertura esperada

- auditor global sobe de 144 para 152 targets;
- basePresent permanece 56;
- baseMissing sobe de 88 para 96 porque as oito colunas V2 não pertencem ao CREATE base do legacy;
- legacyEnsurePresent permanece 0;
- migration 0021 contribui exatamente 8 targets, todos em clover_raids;
- runtime contém exatamente 8 ensures clover_raids e suas definições espelham 1:1 os targets da 0021;
- DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS contém 0021_raid_v2_columns;
- índice mensal, normalizações e handoffs de finalização/mensal permanecem presentes.

## Fora de escopo

- remover ensureColumn de raidV2Schema.js;
- alterar migration 0021;
- alterar pre-bootstrap;
- alterar schemaBaseCatalog/legacy;
- finalização, rewards ou tabelas mensais;
- live DB, PM2 ou Mudzap.

Se este gate fechar, o próximo slice pode remover exclusivamente os oito ensures V2 e o import ensureColumn, preservando o restante do runtime.
