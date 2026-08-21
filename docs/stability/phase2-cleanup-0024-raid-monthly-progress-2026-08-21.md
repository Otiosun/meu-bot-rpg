# FASE 2 — cleanup runtime 0024 Raid Monthly Progress

Data: 21/08/2026

Base canônica: `eca9e68427c54aa5759c4626cb037055c374f0e2` (PR #286).

## Objetivo

Remover exclusivamente o DDL runtime redundante de
`ensureRaidMonthlyProgressSchema` depois de formal 0024 + pre-bootstrap +
coverage 1:1 fechados.

## Mudança runtime

Antes, o wrapper executava 2 `CREATE TABLE IF NOT EXISTS` e 4
`CREATE INDEX IF NOT EXISTS`. Depois do cleanup, a API permanece exportada como:

```js
async function ensureRaidMonthlyProgressSchema(db) {
    void db;
}
```

Isso preserva compatibilidade dos callsites atuais sem permitir que o runtime
volte a assumir ownership do schema.

## Garantias

- exatamente 2 callsites operacionais continuam chamando o wrapper;
- export público permanece;
- nenhuma query de leitura/reserva/liberação/conclusão Monthly é removida;
- migration 0024 e pre-bootstrap 0024 continuam ownership canônico do schema;
- coverage audit pós-cleanup falha se DDL for reintroduzido;
- auditor geral continua 156/56/100/0;
- RaidV2 continua funcional usando pre-bootstrap 0024 nas fixtures;
- live DB/runtime, PM2, Mudzap, deploy e reset ficam fora de escopo.

## Próximo gate

Após merge: auditoria global Raid para fechar Campanha A e então Campanhas B/C/D.


## Nota v3 — fixture formal desacoplada do runtime

O v2 abortou antes de commit/push porque `databaseMigration0024.test.js` ainda
usava `ensureRaidMonthlyProgressSchema()` para montar cinco fixtures de schema
Monthly preexistente. Após o cleanup esse wrapper é intencionalmente no-op.
O v3 corrige o teste formal para montar essas cinco fixtures exclusivamente com
`RAID_MONTHLY_RESERVATIONS_TABLE_SQL`, `RAID_MONTHLY_LEDGER_TABLE_SQL` e
`RAID_MONTHLY_PROGRESS_INDEXES`, removendo qualquer dependência de DDL runtime.
