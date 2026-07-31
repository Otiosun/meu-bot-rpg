# Fase 0 — execução do shadow de cargos

Este comando é somente leitura e deve ser executado contra o snapshot consistente criado pela Fase 0, não contra uma cópia improvisada enquanto o bot escreve.

## Pré-condições

1. Usar worktree separado da pasta executada pelo PM2.
2. Instalar dependências com `npm ci`.
3. Confirmar o SHA da branch de auditoria.
4. Criar o snapshot com `createCloverPhase0Snapshot.js`.
5. Manter os relatórios fora de canais públicos; eles contêm identidades e permissões.

## Execução

```bash
AUDITOR_SHA="$(git rev-parse HEAD)"

node scripts/auditCanonicalRoleShadow.js \
  --db=./backups/clover-phase0-producao.sqlite \
  --expected-auditor-sha="$AUDITOR_SHA" \
  --reference-date="$(date -Iseconds)" \
  --output=./backups/clover-phase0-role-shadow.json \
  --fail-on-critical
```

O comando:

- abre o SQLite com `OPEN_READONLY`;
- confirma `PRAGMA query_only=ON`;
- consulta somente tabelas existentes;
- calcula SHA-256 e metadados antes e depois;
- recusa sobrescrever relatório existente;
- usa permissão `0600` no arquivo de saída;
- retorna código `2` quando `--fail-on-critical` encontra divergências críticas.

## Critério de avanço

Não trocar enforcement para a fonte canônica enquanto houver:

- conflito global entre fontes legadas;
- `legacy_scope_leak`;
- decisão canônica que conceda acesso não concedido pela leitura legada escopada;
- identidade crítica sem classificação e decisão documentada.
