# P0 — Contenção do reconciliador legado de Estrelas

## Decisão

O reconciliador legado não pode escrever enquanto o banco vivo não tiver sido auditado e a migração semântica não estiver aprovada.

A contenção é **fail-closed e absoluta**:

- chamadas existentes continuam retornando resultado estruturado;
- nenhuma Estrela individual é importada para o esquadrão;
- nenhum lançamento `source = squad_reconcile` é criado;
- `current_stars` e `historical_stars` não são sobrescritos;
- a sincronização da descrição do grupo continua usando os valores já armazenados;
- não existe variável de ambiente, parâmetro ou bypass de runtime para reativar a rotina.

Rollback operacional deve ocorrer por reversão explícita de código, com revisão e registro, nunca por uma flag oculta no host.

## Contrato quando bloqueado

```js
{
  ok: true,
  changed: false,
  blocked: true,
  reason: 'legacy_reconcile_disabled',
  squad,
  insertedMissingMemberStars: [],
  ledgerCount: null,
  before: { currentStars, historicalStars },
  after: { currentStars, historicalStars }
}
```

## Critérios antes de substituir a contenção

- [ ] snapshot íntegro do banco vivo;
- [ ] relatório da Fase 0 preservado;
- [ ] lançamentos sintéticos classificados;
- [ ] efeitos de saldo e histórico definidos por tipo de transação;
- [ ] PR de migração revisada;
- [ ] testes de compra, concessão, ajuste e reprocessamento;
- [ ] rollback/compensação documentado.

A futura rotina semântica não deve “reativar” o método antigo. Ela deve substituí-lo por uma implementação nova, baseada no ledger canônico e em efeitos explícitos por transação.
