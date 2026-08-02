# Segurança de mensagens privadas — Fase 2

## Evidência utilizada

O inventário v2 analisou 434 arquivos e encontrou:

- 620 chamadas de mensageria;
- 608 chamadas relevantes ao escopo de PV;
- 576 reativas;
- 9 transacionais;
- 4 proativas já reconhecidas;
- 19 inicialmente desconhecidas;
- nenhum bypass privado confirmado pelo auditor;
- 19 sockets contextuais que ainda precisam passar pelo dispatcher na integração.

A revisão manual dos 19 desconhecidos mostrou:

- respostas de `atualizar`, `registrar` e erro global de comando são reativas;
- avisos de história/persona são transacionais;
- cards de aparência pendente, arquivo e fila enviados a grupos não são PV;
- `transmitirAprovados` e `transmitirHistoria` são transmissões privadas em massa;
- o aviso principal do sweep anti-ghost é proativo;
- fallback da fila privada e transporte de `chatReply` são infraestrutura.

## Corte aprovado

### Preservar

Fluxos reativos:

- respostas a comandos;
- confirmações e erros da ação solicitada;
- respostas privadas de saída/anti-ghost;
- reações e resultados solicitados.

Fluxos transacionais:

- aprovação ou devolução de aparência;
- ajuste de história/persona;
- liberação do jogo;
- instruções pós-ficha;
- link do grupo OFF;
- convite do grupo de avaliação de feitiço;
- confirmação de saída ou retorno da comunidade.

Esses fluxos não usam orçamento diário proativo. Na integração, cada evento transacional deve possuir chave de deduplicação e no máximo duas tentativas.

### Desligar por padrão

- aviso inicial do anti-ghost;
- avisos escalonados do anti-ghost;
- bônus automático de retorno;
- checklist semanal automático no PV.

Esses conteúdos devem migrar para painel, grupo, consulta por comando ou relatório para a staff. A existência de uma flag geral de proativos não reativa essas fontes automaticamente.

### Permitir apenas manualmente

O incentivo individual pode existir somente quando:

- proativos estiverem habilitados explicitamente;
- um administrador confirmar a ação;
- houver exatamente um destinatário;
- existir chave de deduplicação;
- não houver retry automático;
- o envio respeitar orçamento e janela silenciosa.

### Bloquear transmissões em massa por padrão

`transmitirAprovados` e `transmitirHistoria` são os fluxos de maior risco porque percorrem todos os alvos e enviam um PV a cada 350 ms.

Na integração, só poderão funcionar com:

- flag geral de proativos;
- flag específica de lote;
- prévia dos alvos;
- confirmação explícita;
- chave única da campanha;
- limite diário padrão de 20 destinatários;
- espaçamento mínimo de 60 segundos;
- uma tentativa por destinatário;
- nenhuma recuperação automática em backlog.

A recomendação operacional continua sendo substituir esses comandos por anúncio em grupo sempre que possível.

## Núcleo criado nesta fase

`helpers/clover/privateMessagePolicy.js` define:

- categorias oficiais;
- disposição de cada fonte conhecida;
- exigência de dedupe transacional;
- proativos desligados por padrão;
- dupla liberação para lote;
- limite diário configurável de lote;
- falha fechada para fontes desconhecidas.

Este núcleo ainda não está conectado ao runtime. Portanto:

- não muda nenhuma mensagem atual;
- não bloqueia nem libera envios reais;
- não abre banco;
- não inicializa WhatsApp;
- não interfere nas branches da Phase 0.

## Próxima integração

A integração só deve acontecer depois dos contratos locais:

1. conectar `deliveryService` ao núcleo;
2. adaptar os fluxos transacionais com dedupe por evento;
3. bloquear checklist e anti-ghost automáticos por padrão;
4. proteger comandos de transmissão em massa;
5. migrar sockets contextuais relevantes para o dispatcher;
6. executar testes sem iniciar Baileys;
7. atualizar a branch sobre a base final da Phase 0 antes do merge.
