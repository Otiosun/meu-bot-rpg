# Política de PV — modos de runtime

O núcleo da política não é conectado automaticamente ao transporte. A integração será gradual e controlada pela variável `CLOVER_PV_POLICY_MODE`.

## `off` — padrão

- comportamento legado preservado;
- nenhuma mensagem é bloqueada;
- a decisão teórica continua disponível para testes;
- ausência ou valor inválido da variável resolve para `off`.

## `observe`

- nenhuma mensagem é bloqueada;
- cada tentativa pode registrar se a política permitiria ou bloquearia;
- usado para localizar fontes sem `source` ou `dedupeKey` antes do enforcement;
- não deve criar retry, fila ou envio adicional.

## `enforce`

- decisão da política passa a ser obrigatória;
- fluxo desconhecido falha fechado;
- transação sem `dedupeKey` é bloqueada;
- checklist, avisos automáticos e bônus automáticos permanecem bloqueados;
- transmissões em massa continuam bloqueadas sem flags e confirmação;
- grupo não entra na política privada.

## Ordem de ativação

1. conectar o adaptador ao transporte sem alterar o modo padrão;
2. marcar respostas reativas como `command_reply`;
3. marcar aparência, história, liberação, pós-ficha, OFF, avaliação e saída com fonte e dedupe;
4. executar em `observe` e revisar todos os bloqueios teóricos;
5. corrigir fontes desconhecidas;
6. ativar `enforce` somente após evidência local completa;
7. manter proativos e lotes desligados até decisão explícita.

## Garantia atual

No head que introduz este documento, o adaptador ainda não é importado por `chatReply.js`, filas, comandos ou `index.js`. Portanto, nenhum comportamento do bot muda até uma PR de integração posterior.