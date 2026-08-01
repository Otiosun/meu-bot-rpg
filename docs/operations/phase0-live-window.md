# Janela operacional P0

Este runbook executa duas mudanças já comprovadas em snapshot, cópias privadas e CI:

1. arquivamento e remoção dos dez placeholders `Cacador` com `id = NULL`, com triggers contra novas identidades vazias;
2. migração dos 18 grants canônicos de cargos, preservando as duas fontes legadas.

O banco vivo não deve ser alterado por comandos manuais fora deste fluxo.

## Arquivos

- `scripts/ops/Invoke-Phase0LiveWindow.ps1`
- `scripts/ops/Phase0LiveWindow.Common.ps1`
- `scripts/ops/Phase0LiveWindow.Sqlite.ps1`
- `scripts/ops/Phase0LiveWindow.Runtime.ps1`

## Garantias

O executor:

- exige os SHAs aprovados das PRs #163, #165 e #166;
- aceita arquivos não rastreados no runtime, mas bloqueia qualquer alteração Git rastreada;
- testa todos os contratos antes de parar o serviço;
- para somente o processo PM2 `clover-rpg`;
- executa `wal_checkpoint(TRUNCATE)` e `integrity_check`;
- cria backup byte a byte antes da primeira alteração;
- gera auditoria nova no banco vivo congelado;
- exige exatamente 10 placeholders homogêneos e sem referências;
- exige exatamente 15 sujeitos, 18 grants, 5 cargos da Central e 14 do controle de acesso;
- aplica cada etapa atomicamente e mantém backups intermediários;
- executa shadow e verificação SQLite pós-migração;
- reinicia o runtime e exige resposta HTTP 2xx no health endpoint;
- restaura automaticamente o backup baseline se qualquer etapa falhar;
- grava transcript, recibos, hashes e manifesto em pasta privada.

## Preflight

O preflight não para o runtime e não altera o banco:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\ops\Invoke-Phase0LiveWindow.ps1 -Mode Preflight
```

Resultado obrigatório:

- worktrees exatos e limpos;
- todos os testes aprovados;
- runtime no SHA esperado;
- `clover-rpg` online;
- recibo `phase0-live-window-preflight-*.json` na pasta privada.

## Apply

O modo `Apply` altera o banco vivo e exige confirmação literal:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\ops\Invoke-Phase0LiveWindow.ps1 `
  -Mode Apply `
  -Confirmation APLICAR-P0-AO-VIVO `
  -Actor natan `
  -Reason "Janela P0 aprovada para conter identidades nulas e migrar cargos canônicos"
```

A execução deve terminar com:

```text
JANELA P0 APLICADA E VALIDADA.
```

O manifesto final fica em:

```text
C:\Users\natan\Documents\clover-phase0-private\phase0-live-window-<timestamp>\window-manifest.json
```

## Rollback manual

O executor já restaura o baseline automaticamente em falhas. Para restauração manual posterior:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\ops\Invoke-Phase0LiveWindow.ps1 `
  -Mode Rollback `
  -Bundle "C:\Users\natan\Documents\clover-phase0-private\phase0-live-window-<timestamp>" `
  -Confirmation RESTAURAR-BASELINE-P0
```

Esse rollback para `clover-rpg`, remove arquivos WAL/SHM residuais, restaura o banco byte a byte, valida o SHA, reinicia o processo e exige health check 2xx.

## Critérios de aborto

Não contornar nenhum destes bloqueios:

- SHA do runtime ou worktree diferente;
- alteração rastreada no runtime;
- teste vermelho;
- PM2 fora do estado esperado;
- `integrity_check` diferente de `ok`;
- quantidade ou assinatura dos placeholders diferente;
- qualquer referência externa aos placeholders;
- sujeito ou grant diferente da evidência aprovada;
- crítico, regressão, expansão indevida ou vazamento no role shadow;
- hash divergente entre banco, recibo e backup;
- health endpoint sem resposta 2xx.

## Fora do escopo

Esta janela não:

- migra os 28 veteranos entre esquadrões;
- altera consumidores para leitura exclusivamente canônica;
- separa conta e persona;
- reconstrói o frontend;
- liga novamente o reconciliador legado de Estrelas.
