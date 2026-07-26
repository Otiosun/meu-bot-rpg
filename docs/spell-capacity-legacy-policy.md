# Política de excesso legado de capacidade de feitiços

## Regra canônica

- Todo personagem começa com exatamente 1 slot pessoal.
- Cada Ticket de Feitiço usado concede +1 slot pessoal.
- A fila de avaliação não cria, ocupa nem reserva capacidade.
- Feitiço aprovado ocupa 1 slot.

## Estado encontrado em 2026-07-26

A auditoria readonly encontrou 7 personagens com 2 feitiços aprovados e apenas 1 slot registrado.

Cinco possuem ao menos um Ticket disponível:

- Artorius D.Malth
- Norihime
- Ophelia Heartfilia
- Ragnar Choronosvill.
- yelena petrov

Dois não possuem Ticket disponível:

- Maksim Faust
- Noctos Sun

## Tratamento seguro

Esses casos recebem o estado lógico `legacy_over_capacity`.

- Nenhum feitiço aprovado é removido, ocultado ou rebaixado automaticamente.
- Nenhum Ticket é consumido automaticamente.
- Nenhum slot gratuito é concedido automaticamente.
- A dívida de capacidade é `feitiços aprovados - slots totais`.
- Enquanto a dívida for maior que zero, novos feitiços não devem ser aprovados.
- Cada Ticket usado reduz a dívida em exatamente 1 ao aumentar a capacidade total.
- A fila continua independente e não altera essa dívida.

## Casos sem Ticket

Maksim Faust e Noctos Sun permanecem com os feitiços preservados e dívida de 1 slot. A regularização exige obtenção e uso futuro de Ticket ou decisão administrativa explicitamente registrada. O sistema não deve inventar prova histórica nem conceder exceção silenciosa.

## Exibição

Posses e Grimório devem mostrar:

- slots totais;
- slots ocupados;
- dívida de capacidade;
- estado `legacy_over_capacity` quando aplicável;
- quantidade de Tickets necessária para regularização;
- aviso de que feitiços antigos foram preservados;
- bloqueio de nova aprovação enquanto não houver espaço.

## Fila atual

A auditoria encontrou 46 personagens com entrada ativa na fila. Isso não altera a capacidade e não é, isoladamente, prova de erro. A idade, o estado e a duplicidade dessas entradas precisam de uma auditoria separada antes de qualquer limpeza.
