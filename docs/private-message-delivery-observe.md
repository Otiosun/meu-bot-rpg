# Observação read-only da fila privada

## Objetivo

Inspecionar `clover_delivery_jobs` no banco real antes de ativar qualquer flag do consumidor privado.

## Garantias

O observador:

- abre o SQLite com `sqlite3.OPEN_READONLY`;
- não importa `index.js`;
- não importa `database.js`;
- não inicializa Baileys ou WhatsApp;
- não executa `INSERT`, `UPDATE`, `DELETE`, `ALTER`, `DROP` ou claims;
- não altera status de jobs;
- não inclui conteúdo de mensagem no relatório;
- mascara JIDs;
- representa dedupe por hash curto, sem expor a chave original.

## Resultado real — 2026-08-02

A suíte completa passou com **59/59 contratos** antes da leitura do banco real.

Relatório `clover.private-delivery-observer.v1` gerado contra o banco real:

- 336 jobs analisados;
- 265 jobs `sent`;
- 59 jobs `failed` e já terminais;
- 12 jobs `pending`;
- 0 jobs privados elegíveis;
- 0 jobs privados bloqueados pela política;
- 0 jobs privados expirados;
- 0 locks de processamento travados;
- 0 duplicidades ativas de `dedupe_key`;
- banco permaneceu com o mesmo tamanho e `LastWriteTime`;
- zero claims, updates, mensagens e inicializações do WhatsApp.

As 12 pendências são exclusivamente jobs de sistema:

- 8 `approve_pending_off`;
- 4 `approve_pending_spell_review`;
- idade aproximada entre 34 e 370 horas no momento do relatório;
- nenhuma possui alvo privado ou dedupe de PV.

Esses kinds não pertencem a `PRIVATE_KINDS` e devem permanecer fora do consumidor privado. O contrato `privateDeliveryWorkerSystemIsolationContract.test.js` prova que:

1. um job de sistema mais antigo e com prioridade maior não é reivindicado pelo worker privado;
2. uma fila contendo somente jobs de sistema aparece vazia para o worker privado;
3. nenhum `UPDATE` é executado nesses jobs.

## Veredito

Não existe backlog privado a processar no banco observado. Ativar as duas flags hoje resultaria em `empty_queue` para o worker privado, sem tocar nas 12 pendências de sistema.

O backlog de sistema é dívida operacional separada e não deve ser resolvido dentro do subprojeto de segurança de PV.

A próxima validação é somente contratual: executar o novo contrato de isolamento e confirmar a suíte em **61/61**. Não é necessário enviar uma mensagem real para concluir a segurança do worker.
