# Fase 0 — Coletor único de evidências

## Objetivo

Executar a coleta da Fase 0 no host sem misturar branches auditoras e sem tocar o banco vivo além da leitura necessária para produzir um snapshot consistente.

O coletor não incorpora a lógica das auditorias. Cada auditor permanece em seu próprio worktree, fixado no SHA aprovado. O coletor valida todos os checkouts, cria o snapshot e chama os comandos na ordem correta.

## Garantias de pré-flight

Antes de criar qualquer arquivo, o comando exige:

- SHA explícito do próprio coletor;
- checkout do coletor limpo;
- exatamente um processo PM2 com o nome configurado;
- processo PM2 em estado `online`;
- `pm_cwd` igual ao `runtime.cwd` configurado;
- SHA do checkout de runtime igual ao SHA esperado;
- ausência de modificações rastreadas no runtime;
- worktrees auditores nos SHAs aprovados;
- worktrees auditores totalmente limpos, inclusive sem arquivos não rastreados;
- presença de todos os scripts necessários;
- banco de origem existente;
- diretório de saída ainda inexistente.

`node_modules` ignorado pelo Git não torna o worktree sujo. O runtime permite arquivos não rastreados porque o próprio `banco.sqlite` pode estar fora do índice, mas alterações rastreadas continuam bloqueadas.

## Ordem executada

1. snapshot consistente pela PR #141;
2. auditoria geral da Fase 0;
3. scanner do reconciliador legado no checkout implantado;
4. shadow canônico de cargos pela PR #153;
5. integridade de vínculos pela PR #154;
6. shadow dos leitores de membros pela PR #158;
7. inventário e simulação de elegibilidade pela PR #159.

Cada auditor roda no seu próprio `cwd` e valida o próprio SHA.

## Códigos de saída

- `0`: coleta tecnicamente válida e nenhuma auditoria bloqueou avanço;
- `2`: coleta tecnicamente válida, mas ao menos uma auditoria encontrou bloqueio;
- `1`: falha técnica, configuração inválida ou violação de integridade.

Código `2` não interrompe as auditorias seguintes. O objetivo é produzir toda a evidência disponível numa única rodada.

## Imutabilidade

Depois do snapshot:

- SHA-256, tamanho e `mtime` são fixados;
- após cada auditoria, os três valores são comparados novamente;
- qualquer alteração interrompe a coleta;
- todos os relatórios e logs são forçados para modo `0600`;
- o diretório de evidência é criado com modo `0700`;
- arquivos existentes nunca são sobrescritos;
- falha técnica gera `clover-phase0.failure.json`;
- sucesso gera manifesto e digest SHA-256 separado.

## Worktrees

Exemplo de preparação:

```bash
git fetch origin

git worktree add ../clover-phase0-audit 17792441785fa209483fc4ca1b5e0281c3bc6ac7
git worktree add ../clover-role-shadow 26cc9c3c8509fa28f0dae88248ac7043d2b0d7eb
git worktree add ../clover-membership-integrity 3299ac1516127103a10b2432090bb615378fcca4
git worktree add ../clover-membership-read-shadow 4661dfb1f00adfb07ca83878023fbde213de4624
git worktree add ../clover-eligibility-status eaf0f73fe4e1756617914d7a7194d5dcdfe4c098
```

Instalar dependências em cada worktree que precise de SQLite:

```bash
npm ci
```

## Configuração

Copiar `config/clover-phase0-evidence.example.json` para um local privado e preencher:

- `runtime.cwd` com o `pm_cwd` real;
- `runtime.expectedSha` com o SHA observado naquele checkout;
- caminhos absolutos ou relativos dos worktrees;
- diretório novo de saída;
- allowlists apenas depois de classificar o primeiro inventário.

## Dry-run

```bash
COLLECTOR_SHA="$(git rev-parse HEAD)"

node scripts/collectCloverPhase0Evidence.js \
  --config=/caminho/privado/clover-phase0-evidence.json \
  --expected-collector-sha="$COLLECTOR_SHA" \
  --dry-run
```

Nenhum diretório de evidência é criado no dry-run.

## Coleta

```bash
node scripts/collectCloverPhase0Evidence.js \
  --config=/caminho/privado/clover-phase0-evidence.json \
  --expected-collector-sha="$COLLECTOR_SHA"
```

## Saídas principais

- `clover-phase0.snapshot.sqlite`;
- `clover-phase0.snapshot.metadata.json`;
- relatórios individuais das auditorias;
- logs privados de stdout/stderr por etapa;
- `clover-phase0.manifest.json`;
- `clover-phase0.manifest.sha256`.

O manifesto registra PM2, runtime, SHAs dos auditores, resultado de cada etapa, bloqueios e hashes dos artefatos.

## Limites

O coletor não:

- mescla PRs;
- corrige dados;
- ativa enforcement;
- reinicia PM2;
- instala dependências;
- publica relatórios;
- envia evidência ao GitHub.

Todo o diretório produzido deve permanecer privado porque pode conter identidades, caminhos do host e detalhes do banco.
