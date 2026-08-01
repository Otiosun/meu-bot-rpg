# Segurança de mensagens privadas — Fase 1

## Objetivo

Inventariar e classificar todos os fluxos de mensagem privada antes de alterar o comportamento do bot.

Esta fase é exclusivamente diagnóstica:

- não abre o banco;
- não importa `index.js`;
- não inicializa Baileys;
- não chama WhatsApp;
- não altera filas, mensagens ou configurações;
- não modifica as branches da remediação Phase 0.

## Categorias oficiais

### Reativa

Resposta causada diretamente por uma ação recente do usuário.

Exemplos:

- resposta a comando no PV;
- confirmação de ficha;
- escolha de magia;
- resposta de saída;
- erro ou sucesso da operação solicitada.

Política planejada:

- não disputar orçamento diário com mensagens proativas;
- manter apenas throttle curto contra rajadas;
- não colocar resposta de comando em backlog quando houver trava de alcance.

### Transacional

Mensagem necessária para comunicar uma mudança real de estado.

Exemplos:

- aparência aprovada ou devolvida;
- jogo liberado;
- convite do grupo OFF;
- convite do grupo de avaliação de feitiço;
- confirmação de saída ou retorno;
- resultado de ação administrativa.

Política planejada:

- uma mensagem por evento;
- deduplicação obrigatória;
- prioridade sobre mensagens proativas;
- tentativas limitadas;
- nunca ser bloqueada por checklist ou anti-ghost.

### Proativa

Contato iniciado pelo bot sem uma ação imediata do destinatário.

Exemplos:

- anti-ghost;
- checklist semanal;
- bônus de retorno;
- lembretes e incentivos.

Política planejada:

- limite diário aplicado somente a esta categoria;
- janela silenciosa;
- limite global;
- consolidação de mensagens concorrentes;
- desativação por padrão para fluxos de baixo valor.

### Desconhecida

Fluxo que o auditor não conseguiu classificar com segurança.

Política planejada:

- revisão humana obrigatória;
- nenhuma permissão automática para contato proativo;
- prioridade para envios que usam `sock.sendMessage()` diretamente.

## Riscos marcados pelo auditor

- `direct_socket_send`: envio pode escapar do dispatcher central;
- `retry_or_queue`: envio pode reaparecer depois de falha ou trava;
- `multi_target_or_device_fallback`: uma mensagem lógica pode gerar múltiplas tentativas;
- `automatic_schedule`: timer, sweep ou dispatcher automático;
- `unsolicited_outreach`: contato proativo;
- `more_than_three_attempts`: quantidade elevada de tentativas;
- `classification_required`: contexto insuficiente para classificar.

## Critério de saída da Fase 1

A Fase 1 termina somente quando:

1. o auditor passa nos contratos;
2. o relatório real é gerado sem alterar o repositório;
3. todos os fluxos proativos são identificados;
4. todos os `sock.sendMessage()` relevantes são classificados;
5. as mensagens transacionais críticas estão separadas das proativas;
6. existe uma lista concreta do que será mantido, consolidado, movido ou desativado.

Nenhuma política de limite será aplicada antes dessa classificação.
