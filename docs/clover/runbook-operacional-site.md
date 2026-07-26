# Runbook operacional do site Clover

Este runbook fecha a operacao local do bot, API do site e tunel publico sem tocar no banco original nem nos processos MudZap.

## Estado esperado

- PM2 preserva `mudzap`, `mudzap-ngrok` e `clover-rpg` como processos separados.
- `clover-rpg` executa `scripts/startCloverSiteStack.js`.
- A API local responde em `http://127.0.0.1:8787/health`.
- A fila do Clover deve ficar com `depth=0` e `active=false` antes de qualquer manutencao.

## Tunel Cloudflare

O supervisor aceita dois provedores:

```powershell
$env:CLOVER_TUNNEL_PROVIDER = "cloudflare"
$env:CLOVER_CLOUDFLARED_PUBLIC_URL = "https://SEU-DOMINIO"
```

Para tunel nomeado, escolha uma das formas abaixo, sem versionar segredo:

```powershell
$env:CLOVER_CLOUDFLARED_TOKEN = "TOKEN_DO_TUNEL"
```

ou:

```powershell
$env:CLOVER_CLOUDFLARED_TUNNEL = "NOME_OU_ID_DO_TUNEL"
$env:CLOVER_CLOUDFLARED_CONFIG = "C:\caminho\config.yml"
```

Se nenhuma dessas variaveis existir, `cloudflared` sobe um quick tunnel temporario. Use isso somente para smoke, porque a URL muda.

## Fallback ngrok

O padrao segue sendo ngrok para preservar o runtime atual:

```powershell
$env:CLOVER_TUNNEL_PROVIDER = "ngrok"
$env:CLOVER_NGROK_URL = "https://underuse-clamshell-crazily.ngrok-free.dev"
```

## Diagnostico seguro

Comandos somente leitura:

```powershell
pm2 jlist
Invoke-RestMethod http://127.0.0.1:8787/health
where.exe cloudflared
where.exe ngrok
```

Nao execute `pm2 stop`, `pm2 restart`, `pm2 delete`, login de WhatsApp ou migracoes em banco vivo durante validacao.

## Rollback de tunel

Para voltar ao comportamento anterior, remova as variaveis Cloudflare e deixe:

```powershell
$env:CLOVER_TUNNEL_PROVIDER = "ngrok"
```

Depois disso, reinicio do `clover-rpg` so deve ocorrer em janela autorizada. Nao reinicie MudZap.
