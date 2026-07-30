# Plano de limpeza local

Este plano transforma o inventario em uma fila de decisao. Ele nao autoriza
exclusao por si so; serve para executar uma limpeza em lotes pequenos quando
houver autorizacao explicita.

Data: 2026-07-29.

## Regra de ouro

Nao remover:
- repositorio principal `C:/Users/natan/Documents/meu-bot-rpg`;
- `banco.sqlite`, `banco.sqlite-wal`, `banco.sqlite-shm`;
- `auth_info/`;
- `.env` e configs locais;
- backups de banco vivo sem hash e destino externo;
- worktree com arquivo rastreado modificado.

## Estado atual

Ultima auditoria:

```powershell
npm run plan:local-cleanup -- --limit=10 --output=artifacts/local-cleanup-plan-current.md
```

Resultado:
- repositorio principal limpo;
- nenhum worktree antigo com arquivo rastreado modificado;
- alguns worktrees com arquivos nao rastreados que exigem arquivamento antes de
  remocao;
- `backups/` e `artifacts/` concentram quase todo o peso local.

## Lote 1 - worktrees sem alteracao rastreada

Pode ser considerado para arquivamento/remocao local primeiro, desde que nao
haja motivo humano para manter a pasta aberta:

- `C:/Users/natan/Documents/clover-admin-backend-20260727-074303`
- `C:/Users/natan/Documents/clover-admin-items-read-api-20260727`
- `C:/Users/natan/Documents/clover-admin-rewards-validation-20260728-022712`
- `C:/Users/natan/Documents/clover-box-pity-v2-20260727-015351`
- `C:/Users/natan/Documents/clover-dream-worlds-main-sync-20260727-004423`
- `C:/Users/natan/Documents/clover-hooks-v2-validation-20260729-012205`
- `C:/Users/natan/Documents/clover-legacy-entitlements-release-03fa29ff`
- `C:/Users/natan/Documents/clover-legacy-entitlements-v2-wt-20260726-232412`
- `C:/Users/natan/Documents/clover-runtime-integration-20260729-020503`
- `C:/Users/natan/Documents/clover-traits-release-750e4d24`
- `C:/Users/natan/Documents/meu-bot-rpg/backups/dream-worlds-core-dual-fix`
- `C:/Users/natan/Documents/meu-bot-rpg/backups/dream-worlds-validation-b6d7abec`
- `C:/Users/natan/Documents/possessions-v1-backend`
- `C:/Users/natan/Documents/worktrees/clover-final-backend-20260726`
- `C:/Users/natan/Documents/worktrees/clover-runtime-cloudflare-tunnel-main`
- `C:/Users/natan/Documents/worktrees/clover-stack-backend-20260725`

Antes de remover qualquer entrada:

```powershell
git -C "<CAMINHO>" status --short --branch
```

Modelo de comando para uma janela autorizada:

```powershell
git worktree remove "<CAMINHO>"
```

## Lote 2 - worktrees com nao rastreados

Nao remover direto. Arquivar primeiro os nao rastreados:

- `C:/Users/natan/Documents/clover-admin-integrated-preview/backend`
  - `scripts/createRaidFinalizationPreviewSnapshot.js`
  - `scripts/seedRaidFinalizationPreview.js`
  - `scripts/startRaidV2ManualPreview.js`
- `C:/Users/natan/Documents/clover-trait-audit-v1`
  - `artifacts/`
- `C:/Users/natan/Documents/clover-trait-descriptions-v1`
  - `artifacts/`
- `C:/Users/natan/Documents/meu-bot-rpg/backups/captain-personas-registration-v1`
  - `artifacts/`
- `C:/Users/natan/Documents/meu-bot-rpg/backups/captains-season-stars-backend`
  - `artifacts/`

Procedimento recomendado:

1. compactar os nao rastreados;
2. calcular SHA-256 do zip;
3. registrar caminho e hash;
4. so entao remover o worktree.

## Lote 3 - branches locais ja mescladas

Depois de remover worktrees presos, revisar branches locais ja mescladas:

- `agent/refine-reception-trait-attempts`
- `archive/performance-teams-bot-50ced206`
- `feature/dream-world-public-applications`
- `feature/dream-world-publication-status`
- `feature/mundos-dos-sonhos-v1`
- `feature/performance-teams-bot-v1`
- `fix/cloverscript-v11-174700`
- `fix/performance-teams-command-flow`
- `hotfix/raid-dual-schema`
- `integration/clover-admin-safety-v1`
- `reconcile/mundos-dos-sonhos-v1-20260727`

Modelo de comando para uma janela autorizada:

```powershell
git branch -d "<BRANCH_JA_MESCLADA>"
```

Nao remover nesta etapa:
- `backup/*`;
- `release/*`;
- branch usada por worktree ainda existente;
- branch local nao mesclada.

## Lote 4 - backups e artefatos grandes

Maiores candidatos a arquivo externo:

- `backups/player-reset/`
- `backups/dream-worlds-validation-b6d7abec/`
- `backups/player-reset-archive-20260722.zip`
- `artifacts/final-release-validation/`
- `artifacts/traits-live-20260722-222901/`
- `artifacts/runtime-hooks-v2-*`
- `artifacts/runtime-central-adm-20260728-024204/`
- `artifacts/production-release-20260726/`
- `artifacts/remessa-0-audit/`

Regra:
- mover para arquivo externo ou zipar com hash;
- manter pelo menos a evidencia de release/auditoria referenciada por relatorio;
- nao apagar backup vivo recente antes de confirmar rollback alternativo.

## Bloqueados ate decisao humana

Branches locais nao mescladas, worktrees de PR antiga e backups de banco vivo
ficam bloqueados ate uma decisao por nome.

Especial atencao:
- `feat/pa-weekly-shop` aparece localmente como nao mesclada, mas a PR #17 foi
  mesclada; revisar o diff antes de remover;
- `fix/site-auth-session-v1` e `fix/site-api-vercel-connection-v1` foram PRs
  superadas/fechadas sem merge; revisar se ainda ha algum helper util;
- `codex/captain-personas-registration-v1` e `rewrite/captain-personas-registration-v1`
  se relacionam com a PR #135, mas nao devem ser apagadas sem conferir o
  historico de reescrita.

## Autorizacao recomendada

Para executar limpeza real, autorizar em uma frase com escopo fechado, por
exemplo:

```text
Autorizo remover apenas o Lote 1 de worktrees sem alteracao rastreada.
```

Depois disso, conferir novamente:

```powershell
git status --short --branch
git worktree list
npm run plan:local-cleanup -- --limit=10 --output=artifacts/local-cleanup-plan-after.md
```
