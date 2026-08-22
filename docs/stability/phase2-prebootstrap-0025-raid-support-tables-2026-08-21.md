# Fase 2 — promoção pre-bootstrap 0025 Raid support tables

Data: 2026-08-21

Base canônica: `38b03f58442a053094aeca3af1ef9e8dd7bf264f` (formal 0025 mergeada via PR #288).

## Objetivo

Promover `0025_raid_support_tables` ao pre-bootstrap canônico para que bancos ainda não adotados recebam
as seis tabelas auxiliares Raid e seus seis índices pela migration formal antes do bootstrap legacy.

## Semântica

- catálogo base permanece com 19 tabelas;
- pre-bootstrap passa de 23 para 24 migrations transitórias (`0002→0025`);
- as seis tabelas auxiliares nascem vazias em banco fresh;
- Raid legado preserva dados existentes e não recebe rows auxiliares sintéticas;
- ledger de migrations continua ausente e `PRAGMA user_version` continua 0;
- shape parcial/incompatível continua fail-closed pela própria migration 0025;
- Monthly 0024 permanece formalizado e sem retroatividade.

## Fronteira

Esta slice não remove nenhum DDL de `database/legacy.js`.
O legacy continua pinado/intocado até coverage proof 0025 e cleanup dedicado.

Depois do merge: coverage 0025 → cleanup DDL auxiliar Raid no legacy → repetir auditoria global Raid.
