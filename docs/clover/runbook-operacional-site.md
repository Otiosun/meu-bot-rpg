# Runbook operacional do site Clover

Este runbook fecha a operacao local do bot, API do site e tunel publico sem tocar no banco original nem nos processos MudZap.

## Estado esperado

- PM2 preserva `mudzap`, `mudzap-ngrok` e `clover-rpg` como processos separados.
- `clover-rpg` executa `scripts/startCloverSiteStack.js`.
- A API local responde em `http://127.0.0.1:8787/health`.
- A fila do Clover deve ficar com `depth=0` e `active=false` antes de qualquer manutencao.

## Tunel Cloudflare

Nesta remessa, a solucao temporaria aprovada e manter o Quick Tunnel atual fora do supervisor:

```text
https://her-flex-wellington-cassette.trycloudflare.com
```

Para preservar esse tunel manual, deixe o PM2 com:

```powershell
$env:CLOVER_TUNNEL_PROVIDER = "none"
```

Assim `clover-rpg` sobe somente bot + API local, sem tentar criar outro tunel e sem encerrar o Quick Tunnel funcional.

O suporte a Cloudflare no supervisor e opcional. Para um quick tunnel gerenciado pelo supervisor em smoke futuro:

```powershell
$env:CLOVER_TUNNEL_PROVIDER = "cloudflare"
$env:CLOVER_CLOUDFLARED_PUBLIC_URL = "https://URL-APROVADA"
```

Para tunel nomeado futuro, escolha uma das formas abaixo, sem versionar segredo:

```powershell
$env:CLOVER_CLOUDFLARED_TOKEN = "TOKEN_DO_TUNEL"
```

ou:

```powershell
$env:CLOVER_CLOUDFLARED_TUNNEL = "NOME_OU_ID_DO_TUNEL"
$env:CLOVER_CLOUDFLARED_CONFIG = "C:\caminho\config.yml"
```

Se nenhuma dessas variaveis existir e `CLOVER_TUNNEL_PROVIDER=cloudflare`, `cloudflared` sobe um quick tunnel temporario. Nao use isso para substituir o Quick Tunnel ja funcional sem janela autorizada.

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

Para manter a solucao temporaria aprovada desta remessa, remova variaveis Cloudflare/ngrok e deixe:

```powershell
$env:CLOVER_TUNNEL_PROVIDER = "none"
```

Depois disso, reinicio do `clover-rpg` so deve ocorrer em janela autorizada. Nao reinicie MudZap.
