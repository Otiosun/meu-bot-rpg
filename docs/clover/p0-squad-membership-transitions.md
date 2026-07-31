# P0 — Transferências atômicas de membros

## Problema

O fluxo atual possui apenas adicionar e remover. Uma troca de esquadrão depende de duas ações independentes, permitindo estados intermediários como:

- personagem sem vínculo ativo entre remoção e inclusão;
- vínculo encerrado, mas `jogadores.esquadrao` ainda apontando para a origem;
- inclusão no destino sem encerramento correto do histórico anterior;
- retry duplicando eventos ou vínculos.

## Serviço

`transferSquadMember()` executa a transferência inteira em `BEGIN IMMEDIATE`.

A transação:

1. confirma autorização para gerenciar origem e destino;
2. exige exatamente um vínculo ativo;
3. exige coerência entre vínculo ativo, campo legado e origem informada;
4. encerra o vínculo anterior como `transferred`;
5. cria o vínculo ativo no destino;
6. atualiza `jogadores.esquadrao`;
7. grava eventos de saída e entrada;
8. valida as pós-condições;
9. grava um recibo idempotente.

Qualquer falha desfaz todas as etapas.

## Idempotência

A chamada exige `transitionKey` ou `idempotencyKey`.

- mesma chave e mesmo payload: retorna o recibo anterior sem reaplicar;
- mesma chave e payload diferente: `membership_transition_idempotency_conflict`.

O fingerprint inclui personagem, origem, destino e motivo.

## Travas

A transferência falha quando:

- origem e destino são iguais;
- o ator não administra os dois esquadrões;
- não existe vínculo ativo;
- existem vínculos ativos duplicados;
- `jogadores.esquadrao` diverge da origem;
- o vínculo ativo diverge da origem;
- o personagem é Capitão ou Vice da origem.

Mudanças de liderança precisam de um fluxo próprio.

## Ordem de ativação

1. executar a auditoria da PR anterior no snapshot;
2. reduzir duplicidades e divergências críticas a zero;
3. validar a suíte SQLite completa;
4. integrar o serviço à API administrativa;
5. somente depois expor transferência na Central ADM.
