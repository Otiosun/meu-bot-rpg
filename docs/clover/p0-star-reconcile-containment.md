# P0 — Contenção do reconciliador legado de Estrelas

## Decisão

O reconciliador legado não pode escrever por padrão enquanto o banco vivo não tiver sido auditado e a migração semântica não estiver aprovada.

A contenção deve ser **fail-closed**:

- chamadas existentes continuam retornando resultado estruturado;
- nenhuma Estrela individual é importada para o esquadrão;
- nenhum lançamento `source = squad_reconcile` é criado;
- `current_stars` e `historical_stars` não são sobrescritos;
- a sincronização da descrição do grupo continua usando os valores já armazenados;
- reativação exige variável explícita de emergência e não deve ocorrer antes de snapshot e auditoria.

## Flag de emergência

```text
CLOVER_ENABLE_LEGACY_SQUAD_STAR_RECONCILE=1
```

A ausência da variável, valor vazio, `0`, `false` ou qualquer outro valor mantém a reconciliação bloqueada.

A flag não transforma o reconciliador antigo em fonte canônica. Ela existe apenas para rollback operacional consciente e deve ser removida quando o ledger semântico substituir definitivamente a rotina.

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

## Critérios antes de ativar qualquer escrita

- [ ] snapshot íntegro do banco vivo;
- [ ] relatório da Fase 0 preservado;
- [ ] lançamentos sintéticos classificados;
- [ ] efeitos de saldo e histórico definidos por tipo de transação;
- [ ] PR de migração revisada;
- [ ] testes de compra, concessão, ajuste e reprocessamento;
- [ ] rollback/compensação documentado.
