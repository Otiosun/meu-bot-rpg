# Runbook final de publicacao Clover

Este documento prepara a publicacao, mas nao autoriza merge, deploy ou migration. A ordem final deve ser backend primeiro, health/migrations depois, frontend por ultimo.

## Pre-flight

1. Confirmar PRs consolidadas em rascunho e aprovadas.
2. Confirmar `origin/main` backend e frontend antes do merge.
3. Confirmar `pm2` com `mudzap`, `mudzap-ngrok` e `clover-rpg` online.
4. Confirmar `http://127.0.0.1:8787/health` com `depth=0` e `active=false`.
5. Gerar backup do banco vivo e SHA-256 antes de qualquer migration.
6. Confirmar Quick Tunnel temporario aprovado: `https://her-flex-wellington-cassette.trycloudflare.com`.
7. Confirmar `CLOVER_API_UPSTREAM` Production apontando para esse Quick Tunnel.
8. Confirmar que Named Tunnel/dominio ficaram como backlog futuro, nao bloqueante.

## Publicacao protegida

O script assistido exige confirmacao literal e falha se backend ou frontend estiverem sujos:

```powershell
node scripts/prepareCloverProductionRelease.js --confirm=EU_AUTORIZO_PREPARAR_PUBLICACAO_CLOVER
```

Ele gera um plano em `artifacts/production-release/` e nao faz merge, deploy, migration ou restart.

## Ordem de execucao apos autorizacao humana

1. Backup e hash do banco vivo seguindo `docs/clover/runbook-banco-vivo.md`.
2. Merge backend.
3. Atualizar runtime backend em janela autorizada.
4. Rodar migrations autorizadas.
5. `PRAGMA integrity_check`.
6. Health local.
7. Health publico pelo Quick Tunnel aprovado.
8. Smoke de login, perfil, inventario, caixas, titulos, feiticos, Raids e Central ADM.
9. Merge frontend.
10. Deploy Vercel autorizado.
11. Smoke desktop e mobile.

## Rollback

- Backend: voltar ao commit anterior do runtime, restaurar env anterior e reiniciar somente `clover-rpg`.
- Frontend: rollback do deployment Vercel para o deployment anterior.
- Banco: restaurar backup apenas se houver falha confirmada e janela autorizada.
- Tunel: manter `CLOVER_TUNNEL_PROVIDER=none` para preservar o Quick Tunnel manual atual; se uma tentativa futura gerenciada falhar, remover variaveis Cloudflare/ngrok e voltar ao upstream temporario aprovado.

## Proibicoes permanentes

- Nao reiniciar `mudzap` ou `mudzap-ngrok`.
- Nao alterar sessao de WhatsApp.
- Nao publicar producao sem autorizacao explicita.
- Nao versionar `.env.local`, `.vercel`, tokens, bancos, logs ou backups.
