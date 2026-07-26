# Posses, Caixas e Títulos V1

## Escopo

Esta remessa consolida a propriedade e o uso seguro de recompensas já existentes, sem migrar os 18 itens legados e sem inventar capacidade pessoal de feitiços.

## Caixas

- mantém abertura transacional e idempotente;
- normaliza recibo com operação `CX-`, prêmio, quantidade, destino e explicação;
- preserva compatibilidade com os campos anteriores;
- recupera o resultado pelo histórico autenticado;
- registra Título recebido e compensação por repetição no histórico de Títulos.

## Títulos

- vários Títulos podem ser possuídos;
- zero ou um pode ficar ativo;
- índice parcial único protege a regra no SQLite;
- `none`, `nenhum`, `sem-titulo`, `off` e `0` desativam o Título atual;
- concessão, ativação, desativação e compensação ficam registradas;
- compras da Loja de PR usam o mesmo serviço das Caixas.

## Itens utilizáveis

Ações registradas por template ou tipo:

- Ticket de Feitiço: solicitação revisável;
- Cupom de Prioridade: solicitação revisável;
- Passe da Dungeon Exclusiva: solicitação revisável;
- Acesso a Missão Especial: solicitação revisável;
- Vales: uso contextual na compra ou no reparo;
- Caixas: abertura direta no fluxo próprio.

Itens revisáveis são reservados enquanto o pedido está pendente. Aprovação consome uma unidade; recusa ou cancelamento libera a unidade. A resolução exige uma nota auditável.

## Central ADM

O detalhe do jogador passa a expor um módulo de posses com:

- resumo do inventário;
- Título ativo e Títulos possuídos;
- histórico de Títulos;
- itens especiais e suas ações;
- resgates pendentes e anteriores;
- últimas aberturas de Caixa.

## Feitiços

A capacidade pessoal permanece explicitamente como `not_consolidated`. A capacidade global da fila de avaliação não é usada como limite individual.

## Fora do escopo

- migração dos 18 itens legados;
- definição das vagas-base de feitiços;
- definição de Ticket como vaga automática;
- interface frontend;
- publicação ou alteração do banco vivo.
