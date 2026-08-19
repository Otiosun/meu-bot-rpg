# FASE 2 — promoção da 0020 de Raid V1 Bridge ao pre-bootstrap

Data: 19/08/2026

## Objetivo

Promover `0020_raid_v1_bridge` ao pre-bootstrap canônico após a integração da migration 0020.

## Bases canônicas adicionadas

O catálogo base passa de 16 para 18 tabelas, adicionando somente:

- `clover_raids`, no CREATE moderno V1;
- `clover_raid_participants`, no CREATE moderno V1.

As definições reproduzem os CREATE TABLE atuais de `database/legacy.js`.

Em banco antigo, `CREATE TABLE IF NOT EXISTS` preserva a tabela existente e a 0020 executa o bridge.
Em banco vazio, as duas tabelas já nascem modernas e a 0020 é estruturalmente no-op.

## Contrato

- bases: 16 → 18;
- migrations transitórias: 18 → 19;
- última migration transitória: `0020_raid_v1_bridge`;
- catálogo formal continua terminando em 0020;
- ledger continua ausente durante pre-bootstrap;
- `PRAGMA user_version` continua 0;
- `database/legacy.js` permanece intocado;
- o último `ensureColumn()` real, `clover_raids.salary_eligible`, permanece nesta etapa.

## Provas

A fixture old→V1 exige preservação de dados e os backfills `code→raid_key`, `created_by→owner_player_id` e `slots→max_players`.

A fixture fail-closed usa `status='rascunho'` e exige `raid_v1_status_mapping_required` com rollback integral das bases/DDL criados na tentativa.

Também é provado que esta etapa não cria rewards, não adiciona V2 e não adiciona finalização.

## Snapshot real

A lógica desta promoção foi simulada numa cópia do snapshot FASE 0:

- 6 raids preservadas;
- 37 participantes preservados;
- 1 reward preservado;
- hashes lógicos idênticos antes/depois;
- schema idêntico;
- `quick_check=ok`;
- `integrity_check=ok`;
- `foreign_key_check=0`.

## Fora do escopo

Raid V2, normalizações mensais, finalização, rebuild de rewards, remoção do último ensure e qualquer acesso a live/DB/PM2/Mudzap/Raid runtime.
