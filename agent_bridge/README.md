# Clover Agent — ChatGPT Bridge POC v1

Objetivo: provar um circuito de custo zero em que o bot Clover usa uma conversa dedicada do ChatGPT como operador, sem usar API de IA e sem extrair a resposta da interface do ChatGPT.

## Fluxo

1. Jogador usa `.#agente <pergunta>` no PV.
2. O Clover envia `enqueue` ao Google Apps Script.
3. O Apps Script adiciona uma linha `PENDING` na planilha `CLOVER_AGENT_QUEUE_POC`.
4. A extensão Chrome, aberta somente na conversa dedicada, consulta `wake`.
5. Quando existe pendência, a extensão envia um wake fixo ao ChatGPT.
6. O ChatGPT lê a planilha pelo conector Google Drive, responde na coluna `answer`, preenche `answered_at` e muda `status` para `ANSWERED`.
7. O runtime Clover consulta `answers`, envia a resposta ao `chat_id` e só então chama `ack_delivered`.
8. O Apps Script muda o item para `DELIVERED`.

## Estados

- `PENDING`: pergunta registrada, ainda não assumida/respondida.
- `CLAIMED`: reservado para evitar concorrência futura entre múltiplos workers ChatGPT.
- `ANSWERED`: resposta escrita na mailbox e pronta para entrega.
- `DELIVERED`: bot confirmou envio ao jogador.
- `FAILED`: reservado para erro operacional que exija revisão.

## Segurança do POC

- Desligado por padrão (`CLOVER_AGENT_BRIDGE_ENABLED=0`).
- Apps Script exige segredo armazenado em Script Properties.
- Cliente do bot aceita somente endpoint HTTPS.
- ID da pergunta é hash determinístico; não expõe o número do jogador no identificador.
- A resposta só recebe ACK depois que `sock.sendMessage` termina sem `skipped`.
- A extensão não lê nem copia outputs do ChatGPT.
- A extensão só opera na URL exata de conversa configurada.

## Variáveis do bot

```text
CLOVER_AGENT_BRIDGE_ENABLED=1
CLOVER_AGENT_BRIDGE_URL=https://script.google.com/macros/s/SEU_DEPLOYMENT/exec
CLOVER_AGENT_BRIDGE_SECRET=SEGREDO_FORTE
CLOVER_AGENT_BRIDGE_POLL_MS=8000
CLOVER_AGENT_BRIDGE_TIMEOUT_MS=8000
```

## Apps Script

Use a planilha `CLOVER_AGENT_QUEUE_POC`. Abra **Extensões → Apps Script**, cole `google-apps-script/Code.gs`, crie a Script Property `CLOVER_AGENT_BRIDGE_SECRET` e publique como Web App executando como o proprietário.

## Extensão

Carregue `agent_bridge/extension/` como extensão descompactada no Chrome. Nas opções, configure a URL do Web App, o mesmo segredo e a URL exata da conversa dedicada do Clover.

## Runtime

`runAgentAnswerSweep()` busca respostas `ANSWERED`, entrega via WhatsApp e confirma `DELIVERED` somente depois de um envio aceito pelo socket. O timer principal deve permanecer desligado se o bridge não estiver configurado.
