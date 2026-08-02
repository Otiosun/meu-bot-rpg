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

## Canais reconhecidos pelo auditor

### `private`

O destino é explicitamente individual, como `playerId`, `targetJid` ou uma API privada.

### `contextual`

O mesmo fluxo pode responder em grupo ou PV, normalmente por `idChat`. Não deve ser tratado automaticamente como contato privado proativo.

### `group_likely`

O destino apresenta evidência de grupo, como `groupId`, `archiveGroupId`, grupo de registro ou grupo de recepção.

### `unknown`

O destino não pôde ser determinado estaticamente.

## Categorias oficiais

### Reativa

Resposta causada diretamente por uma ação recente do usuário.

Exemplos:

- resposta a comando no PV;
- confirmação de ficha;
- escolha de magia;
- resposta de saída;
- mapa solicitado;
- reação a mensagem;
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

### Não privada

Chamada que utiliza uma API genérica, mas cujo destino é provavelmente um grupo.

Exemplos:

- card do arquivo;
- resumo no grupo de registro;
- mensagem no grupo de avaliação;
- fallback da aprovação de aparência para o grupo responsável.

Esses fluxos permanecem visíveis no inventário, mas não entram no orçamento de PV.

### Infraestrutura

Envio interno do transporte central, como o `sock.sendMessage()` usado dentro de `chatReply.js`.

Esse envio não é tratado como bypass. O risco analisado é o comportamento do transporte, especialmente retries, fanout e dispositivos alternativos.

### Desconhecida

Fluxo que o auditor não conseguiu classificar com segurança.

Política planejada:

- revisão humana obrigatória;
- nenhuma permissão automática para contato proativo;
- prioridade para destinos privados ou contextuais que usam socket diretamente.

## Riscos marcados pelo auditor

- `direct_private_socket_bypass`: PV confirmado enviado fora do dispatcher central;
- `direct_contextual_socket_send`: envio por socket cujo destino pode ser PV ou grupo;
- `direct_group_socket_send`: socket direto destinado provavelmente a grupo;
- `transport_core`: chamada pertencente ao transporte central, não um bypass;
- `retry_or_queue`: envio pode reaparecer depois de falha ou trava;
- `multi_target_or_device_fallback`: uma mensagem lógica pode gerar múltiplas tentativas;
- `automatic_schedule`: timer, sweep ou dispatcher automático;
- `unsolicited_outreach`: contato proativo;
- `more_than_three_attempts`: quantidade elevada de tentativas;
- `classification_required`: contexto insuficiente para classificar.

## Garantias do auditor v2

- ignora declarações das próprias funções de envio;
- ignora chamadas escritas apenas dentro de strings ou comentários;
- identifica a função que realmente contém a chamada, em vez de usar a função anterior mais próxima;
- não usa apenas o nome do arquivo para classificar um envio;
- separa grupo provável, transporte central e PV relevante;
- mantém todos os achados no relatório para revisão.

## Critério de saída da Fase 1

A Fase 1 termina somente quando:

1. o auditor passa nos contratos;
2. o relatório real é gerado sem alterar o repositório;
3. todos os fluxos proativos são identificados;
4. todos os bypasses privados ou contextuais são classificados;
5. as mensagens transacionais críticas estão separadas das proativas;
6. existe uma lista concreta do que será mantido, consolidado, movido ou desativado.

Nenhuma política de limite será aplicada antes dessa classificação.