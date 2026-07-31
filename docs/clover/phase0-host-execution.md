# Fase 0 — execução no host real

Este roteiro deve ser executado no diretório realmente usado pelo PM2. Não use uma cópia antiga do repositório apenas porque ela contém `banco.sqlite`.

## 1. Identificar processo, diretório e SHA

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
- SHA completo;
- branch;
- alterações locais;
- horário da coleta.

Não assuma que `main` do GitHub é o que está em execução.

## 2. Preparar a branch da auditoria sem alterar o runtime

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

O banco deve ser referenciado pelo caminho absoluto do runtime. O worktree de auditoria não deve possuir uma segunda cópia tratada como banco vivo.

## 3. Criar snapshot consistente

No worktree da auditoria:

```bash
node scripts/createCloverPhase0Snapshot.js \
  --db=/CAMINHO/REAL/banco.sqlite \
  --expected-sha=<SHA_DO_DIRETORIO_REAL> \
  --output=./backups/clover-phase0-producao.sqlite \
  --metadata=./backups/clover-phase0-producao.metadata.json
```

A rotina:

- recusa sobrescrever snapshot ou metadados;
- recusa iniciar quando o SHA esperado não corresponde ao checkout auditado;
- usa a API de backup consistente do SQLite já existente no projeto;
- abre a origem em modo de leitura;
- valida o destino com `PRAGMA integrity_check`;
- registra método, tamanho, runtime e SHA.

### Atenção sobre SHA

O comando acima compara o SHA informado com o worktree da auditoria. Como o worktree possui commits novos, para preservar a evidência do SHA realmente implantado use uma destas opções:

1. executar o snapshot a partir de uma cópia da branch de auditoria criada sobre o mesmo SHA implantado; ou
2. omitir `--expected-sha` no snapshot e informar o SHA real explicitamente ao auditor e aos metadados operacionais externos.

Não altere o checkout do processo apenas para fazer a comparação coincidir.

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

```bash
node scripts/auditCloverPhase0.js \
  --db=/CAMINHO/REAL/banco.sqlite \
  --expected-sha=<SHA_DO_WORKTREE_AUDITADO> \
  --output=./backups/clover-phase0-producao.json
```

Depois, repita contra o snapshot para confirmar que a fotografia preservada produz a mesma classe de achados:

```bash
node scripts/auditCloverPhase0.js \
  --db=./backups/clover-phase0-producao.sqlite \
  --expected-sha=<SHA_DO_WORKTREE_AUDITADO> \
  --output=./backups/clover-phase0-snapshot.json
```

A contagem e os detalhes podem divergir se o banco vivo tiver recebido novas transações entre o snapshot e a auditoria. O snapshot permanece a referência congelada da análise e da futura migração.

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

- não mover os relatórios para uma pasta rastreada;
- não anexar publicamente o banco;
- não colar IDs completos em issue ou PR;
- mascarar identificadores antes de compartilhar trechos;
- restringir acesso aos arquivos, pois o relatório contém identidades e dados administrativos.

## 7. Critérios de parada imediata

Não iniciar migração se ocorrer qualquer um destes casos:

- `integrity_check` diferente de `ok`;
- snapshot não criado ou não validado;
- diretório do PM2 não confirmado;
- banco auditado não é o banco usado pelo processo;
- SHA implantado desconhecido;
- relatório gerado com `query_only` não confirmado;
- chamada perigosa do reconciliador sem classificação;
- alteração local desconhecida no checkout do runtime.

## 8. Resultado esperado

A Fase 0 não termina quando o script roda. Ela termina quando cada crítico do relatório recebe uma classificação explícita:

```text
dado real a corrigir | defeito de código | dívida de migração | falso positivo comprovado
```

Somente depois disso deve ser criado o plano de escrita, com SQL de prévia, contagem esperada, transação, verificação posterior e rollback ou compensação.
