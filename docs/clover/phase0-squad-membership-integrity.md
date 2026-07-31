# Fase 0 — Integridade dos vínculos de esquadrão

## Objetivo

Classificar divergências entre a projeção legada `jogadores.esquadrao` e o histórico canônico `clover_squad_memberships` antes de alterar consumidores ou migrar membros.

## Garantias

O auditor:

- usa somente `SELECT`, `PRAGMA query_only=ON` e SQLite `OPEN_READONLY`;
- não cria tabelas ou índices;
- não corrige registros;
- não sobrescreve evidência anterior;
- confirma SHA-256, tamanho e `mtime` do snapshot antes e depois;
- grava o relatório com permissão `0600`.

## Achados críticos

- mais de um vínculo ativo para o mesmo personagem;
- vínculo para personagem ou esquadrão inexistente;
- vínculo ativo com `ended_at` preenchido;
- período com encerramento anterior à entrada;
- ausência do índice único de vínculo ativo;
- vínculo ativo divergente de `jogadores.esquadrao`;
- vínculo ativo sem projeção legada, enquanto consumidores ainda leem o campo legado;
- campo legado apontando para esquadrão inexistente.

## Candidatos mecânicos

O relatório pode propor, mas nunca executar:

- criar vínculo ativo a partir de campo legado coerente;
- sincronizar a projeção legada a partir de um único vínculo ativo válido.

Duplicidade, divergência entre esquadrões e referências quebradas sempre exigem decisão humana.

## Execução no snapshot

```bash
AUDITOR_SHA="$(git rev-parse HEAD)"

node scripts/auditSquadMembershipIntegrity.js \
  --db=./backups/clover-phase0-producao.sqlite \
  --runtime-sha=<RUNTIME_SHA> \
  --expected-auditor-sha="$AUDITOR_SHA" \
  --output=./backups/clover-phase0-memberships.json \
  --fail-on-critical
```

Código de saída `2` significa que o relatório foi produzido, mas existem achados críticos.

## Critério de avanço

Não trocar `listSquadMembers`, `resolveSquad(playerId)` ou demais consumidores para a fonte canônica enquanto:

1. o snapshot real não tiver sido auditado;
2. cada achado crítico não estiver classificado;
3. vínculos ativos duplicados não forem reduzidos a zero;
4. a projeção legada e o vínculo ativo não estiverem coerentes;
5. o índice único de vínculo ativo não estiver confirmado.
