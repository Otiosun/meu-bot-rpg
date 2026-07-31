# P0 — Inventário de status para elegibilidade de esquadrão

## Problema

A PR #138 propôs allowlists de `ficha_status` e `jogo_status` antes de existir evidência dos valores realmente gravados no banco. Mesclar essa regra sem inventário pode bloquear personagens legítimos por diferenças de acento, gênero, capitalização, termos históricos ou campos vazios.

## Auditoria

O relatório registra:

- valores brutos de `ficha_status` e `jogo_status`;
- formas normalizadas e respectivas contagens;
- colisões de formas brutas que viram o mesmo token;
- combinações ficha × jogo;
- populações de membros ativos, membros legados e candidatos sem esquadrão;
- campos ausentes no schema;
- callsites atuais que consultam os status.

## Simulação opcional

Allowlists podem ser fornecidas repetidamente:

```bash
--approved-sheet-status=aprovada \
--approved-sheet-status=aprovado \
--released-game-status=liberada \
--released-game-status=liberado
```

A simulação mede:

- candidatos elegíveis;
- candidatos bloqueados e motivo;
- membros atuais que falhariam;
- status observados fora da política.

Ela nunca altera banco ou política ativa. O relatório declara `policyApplied: false`.

## Execução

```bash
AUDITOR_SHA="$(git rev-parse HEAD)"

node scripts/auditSquadMembershipEligibilityStatuses.js \
  --db=./backups/clover-phase0-producao.sqlite \
  --root=. \
  --expected-auditor-sha="$AUDITOR_SHA" \
  --output=./backups/clover-phase0-membership-eligibility-statuses.json
```

Após decidir allowlists, repetir o comando com os status explícitos e `--fail-on-policy-risk`.

## Garantias

- `OPEN_READONLY` e `PRAGMA query_only=ON`;
- hash, tamanho e `mtime` preservados;
- SHA do auditor verificado antes de abrir o banco;
- relatório privado `0600` sem sobrescrita;
- nenhum schema criado;
- nenhuma elegibilidade aplicada.

## Critério para substituir a PR #138

1. inventário real preservado;
2. cada valor observado classificado;
3. allowlists aprovadas explicitamente;
4. `existingMemberFailureCount = 0`, ou exceções documentadas e tratadas;
5. nova PR rebaseada sobre o `main` atual, sem reaproveitar cegamente a implementação antiga.
