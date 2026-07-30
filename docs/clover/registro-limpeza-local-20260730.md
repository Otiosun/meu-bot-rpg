# Registro de limpeza local - 2026-07-30

Este registro documenta a primeira execucao real da limpeza local. A operacao
nao tocou em banco vivo, PM2, bot, WhatsApp, tunel, runtime ou frontend.

## Escopo autorizado/executado

Foi executado apenas o Lote 1 do plano de limpeza local:

- worktrees sem alteracao rastreada;
- remocao via `git worktree remove`;
- sem `--force`;
- sem `git clean`;
- sem `reset`;
- sem `prune`;
- sem remocao manual recursiva.

Auditorias geradas em `artifacts/`:

- `artifacts/local-cleanup-before-lote1.md`
- `artifacts/local-cleanup-lote1-result.txt`
- `artifacts/local-cleanup-after-lote1.md`

## Resultado

Worktrees removidos com sucesso:

- `C:/Users/natan/Documents/clover-admin-backend-20260727-074303`
- `C:/Users/natan/Documents/clover-admin-items-read-api-20260727`
- `C:/Users/natan/Documents/possessions-v1-backend`
- `C:/Users/natan/Documents/worktrees/clover-final-backend-20260726`
- `C:/Users/natan/Documents/worktrees/clover-runtime-cloudflare-tunnel-main`
- `C:/Users/natan/Documents/worktrees/clover-stack-backend-20260725`

O Git tambem desregistrou os worktrees abaixo, mas nao removeu os diretorios do
disco porque havia restos locais, principalmente `node_modules`:

- `C:/Users/natan/Documents/clover-admin-rewards-validation-20260728-022712`
- `C:/Users/natan/Documents/clover-box-pity-v2-20260727-015351`
- `C:/Users/natan/Documents/clover-dream-worlds-main-sync-20260727-004423`
- `C:/Users/natan/Documents/clover-hooks-v2-validation-20260729-012205`
- `C:/Users/natan/Documents/clover-legacy-entitlements-release-03fa29ff`
- `C:/Users/natan/Documents/clover-legacy-entitlements-v2-wt-20260726-232412`
- `C:/Users/natan/Documents/clover-runtime-integration-20260729-020503`
- `C:/Users/natan/Documents/clover-traits-release-750e4d24`

Diretorios vazios remanescentes:

- `C:/Users/natan/Documents/meu-bot-rpg/backups/dream-worlds-core-dual-fix`
- `C:/Users/natan/Documents/meu-bot-rpg/backups/dream-worlds-validation-b6d7abec`

Nada disso esta mais listado como worktree ativo pelo Git.

## Worktrees ainda ativos

Depois do Lote 1, restaram:

- `C:/Users/natan/Documents/meu-bot-rpg` - `main`
- `C:/Users/natan/Documents/clover-admin-integrated-preview/backend` - detached
- `C:/Users/natan/Documents/clover-trait-audit-v1` - detached
- `C:/Users/natan/Documents/clover-trait-descriptions-v1` - detached
- `C:/Users/natan/Documents/meu-bot-rpg/backups/captain-personas-registration-v1` - `rewrite/captain-personas-registration-v1`
- `C:/Users/natan/Documents/meu-bot-rpg/backups/captains-season-stars-backend` - `feature/captains-season-stars-v1`

Esses entram no Lote 2, porque possuem arquivos nao rastreados ou artefatos que
devem ser arquivados antes de remocao.

## Estado do repositorio principal

Ao fim da execucao:

```powershell
git status --short --branch
```

Resultado:

```text
## main...origin/main
```

## Proximo passo

Proxima limpeza possivel:

1. arquivar e hashear os nao rastreados do Lote 2;
2. remover os worktrees restantes;
3. depois revisar branches locais ja mescladas com `git branch -d`.

Nao remover diretorios remanescentes manualmente sem uma autorizacao separada,
porque isso ja nao e mais `git worktree remove`; vira limpeza de filesystem.
