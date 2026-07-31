# P0 — Shadow dos leitores de membros

## Objetivo

Medir o efeito da troca de `jogadores.esquadrao` para `clover_squad_memberships` antes de alterar qualquer resposta do bot ou do site.

## Consumidores impactados

O relatório modela os três usos atualmente dependentes do campo legado:

- listagem de membros em `listSquadMembers`;
- resolução do esquadrão por personagem em `resolveSquad(playerId)`;
- conjunto usado na participação de raids em `squadMemberIds`.

## Estados por personagem

- `consistent`: vínculo ativo e campo legado concordam;
- `legacy_only`: o painel atual inclui, mas o leitor canônico excluiria;
- `canonical_only`: o vínculo ativo existe, mas o painel atual omite;
- `mismatch`: as duas fontes apontam para esquadrões diferentes;
- `multiple_active`: a fonte canônica é ambígua e nenhuma escolha é feita;
- `none`: nenhuma fonte possui vínculo.

## Segurança

O serviço:

- usa somente `SELECT`;
- tolera tabelas ausentes;
- não cria schema;
- não escreve logs no banco;
- retorna `write: false`;
- retorna `queryOnlySafe: true`;
- retorna `enforcementChanged: false`.

## Critério para troca

`safeToSwitchConsumers` só será verdadeiro quando:

1. não existir personagem divergente;
2. não existir duplicidade ativa;
3. nenhum membro entrar ou sair de conjunto ao trocar a fonte;
4. todos os esquadrões referenciados existirem.

A existência deste serviço não autoriza a troca. O resultado precisa ser validado no snapshot real produzido na Fase 0.
