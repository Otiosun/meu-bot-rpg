# Observação read-only da fila privada

Este estágio inspeciona `clover_delivery_jobs` sem iniciar o bot, sem abrir WhatsApp e sem alterar jobs.

## Garantias

- SQLite aberto com `sqlite3.OPEN_READONLY`;
- nenhuma importação de `index.js` ou `database.js`;
- somente consultas `SELECT`;
- nenhum claim, retry, cancelamento ou mudança de status;
- nenhum conteúdo de mensagem no relatório;
- JIDs mascarados para os quatro últimos dígitos;
- chaves de deduplicação representadas apenas por hash SHA-256 curto;
- arquivo JSON de saída criado sem sobrescrever relatório anterior.

## Decisões observadas

- `eligible`: job pendente que a política permitiria processar;
- `policy_blocked`: proativo, desconhecido ou transação sem requisitos;
- `expired`: job acima da validade configurada;
- `scheduled_future`: `run_after` ainda não atingido;
- `processing`: job com lock recente;
- `stale_processing`: lock ausente ou antigo;
- `terminal`: `sent`, `failed` ou `cancelled`;
- `ignored_non_private`: tipo fora do consumidor privado.

O relatório serve para decidir se as duas flags de execução controlada podem ser testadas. Ele não ativa nenhuma flag.
