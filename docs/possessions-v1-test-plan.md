# Plano de validação — Possessions V1

## Suíte cirúrgica

```bash
npm run test:possessions-v1
```

Cobre:

- zero ou um Título ativo;
- opção de não usar Título;
- histórico de concessão, ativação e desativação;
- reserva e liberação de Ticket e Cupom;
- aprovação consumindo somente a unidade reservada;
- nota obrigatória na resolução administrativa;
- Vale contextual fora da fila de resgates;
- recibo normalizado e recuperação de abertura de Caixa;
- capacidade pessoal de feitiços não consolidada.

## Regressões afetadas

```bash
npm run test:admin-core
npm run test:event-economy
npm run test:raid-finalization
```

## Validação única

```bash
node scripts/runPossessionsV1Validation.js
```

## Snapshot

Executar depois sobre uma cópia consistente do banco atual. Confirmar:

- criação do índice parcial de Título;
- backfill de 27 concessões no histórico;
- nenhuma alteração nos 18 itens legados;
- 161 recibos antigos serializáveis;
- 24 Tickets e 3 Cupons preservados;
- zero resgates criados automaticamente.
