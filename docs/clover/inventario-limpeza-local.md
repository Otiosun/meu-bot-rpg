# Inventario e limpeza local

Este documento separa codigo versionado, worktrees, backups e artefatos locais do
backend Clover. A ideia e reduzir ruido operacional sem apagar evidencia,
backup ou sessao viva por engano.

Data do inventario: 2026-07-29.

Head observado:
- `main` local: `7dfed1b32c6e0009e37283988f1538f96102ffea`
- `origin/main`: sincronizado no momento do inventario

## Estado do repositorio principal

Resultado esperado:
- `git status --short --branch` limpo em `main`;
- nenhum arquivo rastreado pendente;
- arquivos ignorados preservados.

O repositorio esta organizado para revisao externa. A bagunca restante e quase
toda operacional: worktrees antigos, backups SQLite, artefatos de auditoria,
logs, previews e sessoes locais.

## Nao apagar automaticamente

Nunca remover em limpeza rapida:

- `banco.sqlite`
- `banco.sqlite-wal`
- `banco.sqlite-shm`
- `auth_info/`
- `.env` e variantes locais
- `config/owner-access.json`
- `config/custom-messages.json`
- backups criados imediatamente antes de escrita em banco vivo
- artefatos de auditoria usados como evidencia de release

Esses itens podem parecer lixo para Git, mas fazem parte de runtime,
autenticacao, rollback ou auditoria.

## Tamanho local relevante

Maiores diretorios ignorados no inventario:

| Caminho | Tamanho aproximado |
| --- | ---: |
| `backups/` | 7.87 GB |
| `artifacts/` | 948.77 MB |
| `node_modules/` | 78.34 MB |
| `tools/` | 51.65 MB |
| `logs/` | 18.45 MB |
| `assets/appearance/` | 12.83 MB |
| `previews/` | 4.15 MB |
| `auth_info/` | 3.47 MB |
| `temp/` | 0.02 MB |
| `tmp/` | 0.01 MB |

Conclusao:
- o ganho real de espaco esta em `backups/` e `artifacts/`;
- `node_modules/` nao e problema agora;
- `auth_info/` e pequeno e sensivel, deve ser preservado;
- `logs/`, `temp/`, `tmp/` podem receber politica de retencao futura.

## Backups grandes

Maiores entradas em `backups/`:

| Entrada | Tamanho aproximado | Observacao |
| --- | ---: | --- |
| `player-reset/` | 3.48 GB | maior candidato a arquivamento externo |
| `dream-worlds-validation-b6d7abec/` | 479.95 MB | worktree/validacao antiga |
| `player-reset-archive-20260722.zip` | 433.76 MB | candidato a manter fora do repo local |
| `before-captain-registration-*.sqlite` | 4 x 96.32 MB | backups repetidos da instalacao de capitaes |
| `before-edmund-admin-role-*.sqlite` | 89.39 MB | backup operacional especifico |
| `captains-stars-live-preinstall-*.sqlite` | 89.25 MB | backup de instalacao vivo |
| `dream-worlds-before-*.sqlite` | 82-84 MB cada | backups de Mundos dos Sonhos |
| `dream-worlds-core-dual-fix/` | 73.22 MB | worktree de fix ja mesclado |

Politica sugerida:
- manter backups de banco vivo recentes e nomeados por release;
- mover para arquivo externo os backups muito grandes de investigacao antiga;
- apagar apenas depois de confirmar que ha copia externa verificavel por hash.

## Artefatos grandes

Maiores entradas em `artifacts/`:

| Entrada | Tamanho aproximado | Observacao |
| --- | ---: | --- |
| `final-release-validation/` | 140.34 MB | evidencia de release |
| `traits-live-20260722-222901/` | 125.16 MB | evidencia operacional |
| `runtime-hooks-v2-*` | 100 MB cada | validacoes de runtime |
| `runtime-central-adm-20260728-024204/` | 88.11 MB | validacao Central ADM |
| `production-release-20260726/` | 70.16 MB | evidencia de publicacao |
| `remessa-0-audit/` | 69.97 MB | auditoria Remessa 0 |
| `admin-traits-v2-*` | 61 MB cada | validacoes antigas |

Politica sugerida:
- manter artefatos referenciados por relatorio final ou auditoria;
- compactar artefatos historicos em `artifacts/archive/` ou mover para disco
  externo;
- nunca apagar uma auditoria antes de registrar onde ela foi arquivada.

## Worktrees ativos

Worktrees observados:

| Caminho | Branch/estado | Observacao |
| --- | --- | --- |
| `C:/Users/natan/Documents/meu-bot-rpg` | `main` | repositorio principal vivo |
| `C:/Users/natan/Documents/clover-admin-backend-20260727-074303` | `feat/admin-center-backend-completion-v1` | trabalho administrativo antigo |
| `C:/Users/natan/Documents/clover-admin-integrated-preview/backend` | detached `73d2ef2e` | preview antigo |
| `C:/Users/natan/Documents/clover-admin-items-read-api-20260727` | `feat/admin-items-read-api-v1` | PR/experimento antigo |
| `C:/Users/natan/Documents/clover-admin-rewards-validation-20260728-022712` | detached `e6195f8a` | validacao antiga |
| `C:/Users/natan/Documents/clover-box-pity-v2-20260727-015351` | `work/box-pity-v2-20260727-015351` | trabalho nao mesclado |
| `C:/Users/natan/Documents/clover-dream-worlds-main-sync-20260727-004423` | `integration/dream-worlds-main-sync-20260727-004423` | integracao antiga |
| `C:/Users/natan/Documents/clover-runtime-integration-20260729-020503` | `integration/runtime-hooks-v2-20260729-020503` | integracao runtime |
| `C:/Users/natan/Documents/meu-bot-rpg/backups/captain-personas-registration-v1` | `rewrite/captain-personas-registration-v1` | rewrite antigo |
| `C:/Users/natan/Documents/meu-bot-rpg/backups/captains-season-stars-backend` | `feature/captains-season-stars-v1` | ja mesclado em main |
| `C:/Users/natan/Documents/meu-bot-rpg/backups/dream-worlds-core-dual-fix` | `codex/dream-worlds-core-dual-fix` | ja mesclado em main |
| `C:/Users/natan/Documents/possessions-v1-backend` | `feat/possessions-boxes-titles-v1` | PR/validacao antiga |

Segunda checagem:
- nenhum worktree tinha arquivo rastreado modificado;
- alguns worktrees tinham arquivos nao rastreados ou ignorados que devem ser
  preservados ou arquivados antes de qualquer remocao.

Worktrees com nao rastreados:

| Caminho | Nao rastreados | Observacao |
| --- | ---: | --- |
| `clover-admin-integrated-preview/backend` | 3 | scripts de preview de Raid V2 |
| `clover-trait-audit-v1` | 1 | `artifacts/` local |
| `clover-trait-descriptions-v1` | 1 | `artifacts/` local |
| `backups/captain-personas-registration-v1` | 1 | `artifacts/` local |
| `backups/captains-season-stars-backend` | 1 | `artifacts/` local |

Scripts nao rastreados em `clover-admin-integrated-preview/backend`:
- `scripts/createRaidFinalizationPreviewSnapshot.js`
- `scripts/seedRaidFinalizationPreview.js`
- `scripts/startRaidV2ManualPreview.js`

Regra:
- antes de apagar uma branch local, remover ou arquivar o worktree que usa a
  branch;
- antes de remover um worktree detached, confirmar se nao contem arquivo nao
  rastreado util.

## Decisao operacional sugerida para worktrees

Pode ser arquivado primeiro, pois nao tem alteracao rastreada:

- `clover-admin-backend-20260727-074303`
- `clover-admin-items-read-api-20260727`
- `clover-admin-rewards-validation-20260728-022712`
- `clover-box-pity-v2-20260727-015351`
- `clover-dream-worlds-main-sync-20260727-004423`
- `clover-hooks-v2-validation-20260729-012205`
- `clover-legacy-entitlements-release-03fa29ff`
- `clover-legacy-entitlements-v2-wt-20260726-232412`
- `clover-runtime-integration-20260729-020503`
- `clover-traits-release-750e4d24`
- `backups/dream-worlds-core-dual-fix`
- `backups/dream-worlds-validation-b6d7abec`
- `possessions-v1-backend`
- `worktrees/clover-final-backend-20260726`
- `worktrees/clover-runtime-cloudflare-tunnel-main`
- `worktrees/clover-stack-backend-20260725`

Arquivar com cuidado por conter nao rastreados:

- `clover-admin-integrated-preview/backend`
- `clover-trait-audit-v1`
- `clover-trait-descriptions-v1`
- `backups/captain-personas-registration-v1`
- `backups/captains-season-stars-backend`

Nao mexer:
- `C:/Users/natan/Documents/meu-bot-rpg`, que e o repositorio principal vivo.

## Branches locais ja mescladas em `main`

Podem virar candidatos a remocao local depois de checar worktree e arquivos nao
rastreados:

- `agent/refine-reception-trait-attempts`
- `archive/performance-teams-bot-50ced206`
- `backup/local-before-central-20260728-024204`
- `backup/main-before-clover-admin-safety-20260713-140947`
- `backup/mundos-dos-sonhos-local-783427f`
- `backup/pre-economy-20260718-005830`
- `codex/dream-worlds-core-dual-fix`
- `feature/captains-season-stars-v1`
- `feature/dream-world-public-applications`
- `feature/dream-world-publication-status`
- `feature/mundos-dos-sonhos-v1`
- `feature/performance-teams-bot-v1`
- `fix/cloverscript-v11-174700`
- `fix/performance-teams-command-flow`
- `hotfix/raid-dual-schema`
- `integration/clover-admin-safety-v1`
- `ops/clover-runtime-cloudflare-tunnel-main`
- `reconcile/mundos-dos-sonhos-v1-20260727`
- `release/clover-final-backend-20260726`
- `release/clover-stack-backend-20260725`
- `rewrite/captain-personas-registration-v1`

Nao apagar ainda sem uma rodada de conferencia:
- branches `backup/*`;
- branches presas a worktree;
- branches de release usadas como referencia de auditoria.

## Branches locais nao mescladas em `main`

Requerem decisao antes de limpeza:

- `backup/captain-personas-registration-pre-rewrite-261187c`
- `backup/local-before-clover-admin-safety`
- `backup/pa-weekly-shop-pre-rebase`
- `backup/pre-central-20260719-122059`
- `codex/captain-personas-registration-v1`
- `codex/economy-pr-foundation-v1`
- `feat/admin-center-backend-completion-v1`
- `feat/admin-items-read-api-v1`
- `feat/admin-rewards-v1`
- `feat/character-presentation-contract-v1`
- `feat/character-presentation-semantics-v1`
- `feat/pa-weekly-shop`
- `feat/possessions-boxes-titles-v1`
- `fix/community-exit-atomic-claim`
- `fix/database-lifecycle-guard`
- `fix/site-api-vercel-connection-v1`
- `fix/site-auth-session-v1`
- `fix/site-stack-and-public-url`
- `fix/site-stack-runtime-guard-v2`
- `fix/squad-current-stars-v1`
- `integration/dream-worlds-main-sync-20260727-004423`
- `integration/runtime-hooks-v2-20260729-020503`
- `ops/clover-runtime-cloudflare-tunnel-v1`
- `rescue/runtime-local-20260729-020503`
- `runtime/central-adm-20260728-024204`
- `runtime/hooks-v2-20260729-031903`
- `work/box-pity-v2-20260727-015351`

Categorias sugeridas:

- manter como trabalho ativo: branches `feat/*`, `fix/*` e `codex/*` com PR ou
  delta funcional ainda nao decidido;
- arquivar depois: `backup/*`, `rescue/*`, `runtime/*`, `integration/*` sem PR
  ativa;
- investigar: branches com upstream antigo que podem ter PR ja substituida.

## Plano de limpeza segura

Ordem recomendada:

1. Conferir PRs e issues ainda abertas no GitHub.
2. Marcar quais branches nao mescladas ainda possuem valor.
3. Para worktrees antigos, rodar `git status --short --branch` dentro de cada um.
4. Exportar patch de qualquer worktree com trabalho local util.
5. Mover backups e artefatos grandes para arquivo externo.
6. Registrar hashes dos arquivos movidos.
7. Remover branches locais ja mescladas que nao estejam presas a worktree.
8. So depois remover worktrees arquivados.

Comandos de conferencia, sem apagar:

```powershell
git status --short --branch
git worktree list
git branch --merged main
git branch --no-merged main
npm run audit:local-cleanup
```

Comandos de limpeza devem ser executados apenas em uma etapa autorizada
separada. Este inventario nao autoriza exclusao por si so.

## Proximo passo recomendado

Fazer uma rodada curta de decisao:

1. quais PRs antigas ainda importam;
2. quais backups devem ir para arquivo externo;
3. quais worktrees podem virar patch/zip;
4. quais branches ja mescladas podem ser removidas localmente.

Depois disso, a limpeza vira mecanica e auditavel.
