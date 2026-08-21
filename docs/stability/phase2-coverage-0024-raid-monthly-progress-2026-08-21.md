# FASE 2 — coverage proof 0024 Raid Monthly Progress

Data: 21/08/2026

Base canônica: `cb39af260c5ac7602c05492bd6ec9e6c291f495f` (PR #285).

## Objetivo

Provar, antes do cleanup runtime, que o DDL ainda existente em
`ensureRaidMonthlyProgressSchema` está coberto 1:1 pela migration formal
`0024_raid_monthly_progress` + pre-bootstrap canônico.

A 0024 é migration de table-shape/constraints. Este proof NÃO cria falsos
targets de coluna; o auditor geral permanece `156/56/100/0`.

## Cobertura exigida

- 2 `CREATE TABLE` runtime correspondem exatamente às duas tabelas formais;
- 4 `CREATE INDEX` runtime correspondem exatamente aos quatro índices formais,
  incluindo ordem e `DESC`;
- 0024 está no pre-bootstrap canônico (23 migrations transitórias);
- migration formal mantém gates fail-closed de table shape, índices e estado
  armazenado incompatível;
- migration formal mantém invariante não retroativo e não lê Raid histórica;
- export `ensureRaidMonthlyProgressSchema` e callsites operacionais permanecem;
- estado pós-cleanup é sintetizado e validado antes da remoção real.

## Cleanup esperado no próximo slice

O próximo cleanup deve remover SOMENTE DDL do wrapper e preservar a API:

```js
async function ensureRaidMonthlyProgressSchema(db) {
    void db;
}
```

Os callsites de leitura/reserva/liberação/conclusão Monthly NÃO são removidos.
Reintroduzir DDL no wrapper depois do cleanup deve falhar fechado.

## Fronteira

Este coverage é aditivo e NÃO altera runtime, migration formal, pre-bootstrap,
catálogo base, auditor, banco live, PM2, Mudzap, deploy ou reset.

## Nota v2 do harness

O v1 abortou antes de commit/push com 44/47 porque dois pressupostos do próprio
coverage estavam errados: o código `raid_monthly_state_mapping_required` vive
na helper `assertRaidMonthlyStoredStateCompatible` chamada pela migration, e a
fixture de remoção do export era sensível a CRLF. O v2 corrige somente essas
provas; runtime/formal/pre-bootstrap/auditor continuam protegidos.
