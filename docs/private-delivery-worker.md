# Consumidor seguro da fila privada

O módulo processa somente `private_text`, `private_message` e `spell_review_invite`.

## Estado padrão

O worker nasce desligado e exige:

```text
CLOVER_PV_DELIVERY_WORKER_ENABLED=1
```

Ele também permanece desconectado do `index.js` nesta etapa. Apenas existir no repositório não inicia timer, não abre banco e não envia mensagem.

## Regras de segurança

Mesmo habilitado manualmente em teste, cada job é avaliado antes do transporte:

- transações conhecidas exigem `dedupe_key`;
- proativos antigos de checklist, anti-ghost e bônus são cancelados sem envio;
- fontes desconhecidas são canceladas sem envio;
- jobs não privados não são reivindicados;
- jobs com mais de 72 horas são cancelados por padrão;
- a validade pode ser ajustada entre 1 e 168 horas com `CLOVER_PV_DELIVERY_MAX_AGE_HOURS`;
- falhas transitórias respeitam `max_attempts` e retornam para `pending` com atraso;
- jobs bloqueados terminam como `cancelled` e permanecem auditáveis;
- `source` e `dedupeKey` são propagados até `sendPrivateText` ou `sendPrivateMessage`.

## Escopo desta PR

Esta etapa cria e testa o consumidor, mas não o conecta ao runtime. A integração posterior deverá começar com uma execução controlada, limite de um job por ciclo e observação dos resultados antes de qualquer timer recorrente.
