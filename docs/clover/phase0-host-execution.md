# Fase 0 — execução no host real

Este roteiro deve ser executado contra o diretório e o banco realmente usados pelo PM2. Não use uma cópia antiga do repositório apenas porque ela contém `banco.sqlite`.

## 1. Identificar processo, diretório e SHA do runtime

```bash
pm2 list
pm2 describe clover-rpg
```

No diretório indicado por `pm_cwd`:

```bash
pwd
git status --short --branch
git rev-parse HEAD
git rev-parse origin/main
```

Registre:

- nome e ID do processo;
- `pm_cwd`;
- caminho do script executado;
- SHA completo do runtime;
- branch;
- alterações locais;
- caminho absoluto do banco;
- horário da coleta.

Não assuma que `main` do GitHub é o que está em execução.

## 2. Preparar o auditor sem alterar o runtime

A auditoria está na branch:

```text
audit/phase0-evidence-containment
```

Não troque a branch do diretório que mantém o bot em execução. Use um worktree separado:

```bash
git fetch origin
git worktree add ../clover-phase0-audit origin/audit/phase0-evidence-containment
cd ../clover-phase0-audit
npm ci
```

No worktree auditor:

```bash
git status --short --branch
git rev-parse HEAD
```

Registre também o SHA do auditor. Ele é diferente do SHA do runtime por design.

## 3. Criar snapshot consistente

```bash
node scripts/createCloverPhase0Snapshot.js \
  --db=/CAMINHO/REAL/banco.sqlite \
  --runtime-sha=<SHA_OBSERVADO_NO_PM2_CWD> \
  --expected-auditor-sha=<SHA_DO_WORKTREE_AUDITOR> \
  --output=./backups/clover-phase0-producao.sqlite \
  --metadata=./backups/clover-phase0-producao.metadata.json
```

A rotina:

- recusa sobrescrever snapshot ou metadados;
- valida apenas o SHA do auditor contra o worktree atual;
- registra separadamente o SHA observado no runtime;
- usa a API de backup consistente do SQLite existente no projeto;
- abre a origem em modo de leitura;
- valida o destino com `PRAGMA integrity_check`;
- calcula SHA-256 do snapshot;
- registra método, tamanho, runtime e auditor.

Não copie `banco.sqlite` com `cp` enquanto o bot puder escrever nele.

## 4. Mapear o reconciliador legado

```bash
node scripts/auditLegacySquadReconcileCallsites.js \
  --root=. \
  --output=./backups/clover-phase0-reconcile-callsites.json
```

Para usar como trava:

```bash
node scripts/auditLegacySquadReconcileCallsites.js \
  --root=. \
  --output=./backups/clover-phase0-reconcile-callsites.json \
  --fail-on-runtime-callsite
```

Código de saída `2` significa que ainda existem referências de runtime que precisam ser classificadas antes da contenção.

## 5. Executar a auditoria read-only

Contra o banco vivo:

```bash
node scripts/auditCloverPhase0.js \
  --db=/CAMINHO/REAL/banco.sqlite \
  --runtime-sha=<SHA_OBSERVADO_NO_PM2_CWD> \
  --expected-auditor-sha=<SHA_DO_WORKTREE_AUDITOR> \
  --output=./backups/clover-phase0-producao.json
```

Depois, repita contra o snapshot:

```bash
node scripts/auditCloverPhase0.js \
  --db=./backups/clover-phase0-producao.sqlite \
  --runtime-sha=<SHA_OBSERVADO_NO_PM2_CWD> \
  --expected-auditor-sha=<SHA_DO_WORKTREE_AUDITOR> \
  --output=./backups/clover-phase0-snapshot.json
```

Para usar como trava operacional:

```bash
node scripts/auditCloverPhase0.js \
  --db=./backups/clover-phase0-producao.sqlite \
  --runtime-sha=<SHA_OBSERVADO_NO_PM2_CWD> \
  --expected-auditor-sha=<SHA_DO_WORKTREE_AUDITOR> \
  --output=./backups/clover-phase0-snapshot.json \
  --fail-on-critical
```

A contagem pode divergir se o banco vivo receber novas transações entre o snapshot e a auditoria. O snapshot permanece a referência congelada da análise e da futura migração.

## 6. Preservar a evidência

Guardar juntos:

```text
clover-phase0-producao.sqlite
clover-phase0-producao.metadata.json
clover-phase0-producao.json
clover-phase0-snapshot.json
clover-phase0-reconcile-callsites.json
```

O diretório `backups/` e arquivos SQLite já estão ignorados pelo Git. Ainda assim:

- não mover relatórios crus para uma pasta rastreada;
- não anexar publicamente o banco;
- não colar IDs completos em issue ou PR;
- mascarar identificadores antes de compartilhar trechos;
- restringir acesso aos arquivos, pois contêm identidades, cargos, vínculos e dados econômicos.

## 7. Critérios de parada imediata

Não iniciar migração se ocorrer qualquer um destes casos:

- `integrity_check` diferente de `ok`;
- violações em `foreign_key_check` sem classificação;
- snapshot não criado ou não validado;
- diretório do PM2 não confirmado;
- banco auditado não é o banco usado pelo processo;
- SHA do runtime desconhecido;
- SHA do auditor desconhecido ou divergente do esperado;
- `query_only` não confirmado;
- chamada perigosa do reconciliador sem classificação;
- alteração local desconhecida no checkout do runtime ou do auditor.

## 8. Resultado esperado

A Fase 0 não termina quando o script roda. Ela termina quando cada crítico do relatório recebe uma classificação explícita:

```text
dado real a corrigir | defeito de código | dívida de migração | falso positivo comprovado
```

Somente depois disso deve ser criado o plano de escrita, com SQL de prévia, contagem esperada, transação, verificação posterior e rollback ou compensação.
