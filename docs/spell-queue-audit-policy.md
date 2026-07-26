# Política de auditoria da fila de feitiços

## Objetivo

Auditar a fila sem cancelar, reordenar, chamar ou concluir entradas automaticamente.

## O que a fila não faz

- não cria slots;
- não reserva slots;
- não consome Ticket de Feitiço;
- não garante aprovação;
- não regulariza excesso legado de capacidade.

## Classificações

A auditoria separa:

- entrada normal;
- espera antiga para revisão a partir de 30 dias;
- espera crítica a partir de 90 dias;
- chamado crítico após 7 dias sem fechamento;
- chamado sem `called_at`;
- entrada ativa com `closed_at`;
- jogador sem cadastro correspondente;
- múltiplas entradas ativas do mesmo jogador;
- jogador sem slot disponível;
- jogador em excesso legado de capacidade;
- histórico encerrado sem `closed_at`.

## Tratamento conservador

- Idade nunca causa cancelamento automático.
- Entrada sem capacidade é preservada, mas não deve resultar em nova aprovação até existir slot.
- Excesso legado preserva feitiços e fila, mas bloqueia nova aprovação até regularização.
- Órfãos e duplicidades exigem revisão de identidade antes de qualquer mudança.
- Chamados antigos exigem revisão administrativa; não retornam para espera automaticamente.

## Privacidade

O relatório usa pseudônimos SHA-256 abreviados. IDs brutos, telefones, sessões e códigos de login não são exportados.
