# Clover — checkpoint local da fila universal

Este runbook aplica **Gates 1–4** no runtime local sem cortar o fluxo legado de Feitiços.

## Garantias

- `auth_info/` não é alterado.
- `CLOVER_UNIVERSAL_EVALUATION` permanece **OFF** durante checkout/migrations/restart inicial.
- PM2 é parado **antes** de trocar a branch.
- um backup SQLite verificado é criado **antes do checkout**.
- o runtime local canônico parte de `PRAGMA user_version = 54`.
- as migrations históricas `31–54` não são reexecutadas nem renumeradas; elas são aceitas somente por atestação exata de `version + migration_key + checksum` lida do ledger canônico.
- as migrations novas desta tranche são aditivas e ocupam exclusivamente `55–58`.
- `PRAGMA user_version` precisa terminar em `58`.
- `PRAGMA integrity_check` precisa ser `ok`.
- `pm2 save` não é executado; o enable continua reversível.
- `CLOVER_STRICT_COMMAND_OWNERSHIP` permanece OFF porque ainda existem colisões legadas conhecidas.
- se o bootstrap falhar após parar o runtime, ele tenta restaurar **SQLite + branch/SHA anteriores + PM2** automaticamente.

## 1. Bootstrap recomendado — Node standalone, rollback-safe

No PowerShell 5.1, dentro do repo atual do Clover, ainda com `clover-rpg` online:

```powershell
git fetch origin
git show origin/clover/evaluation-support-migration-2026-10-13:scripts/bootstrapUniversalEvaluationLocal.js | Set-Content -Encoding ASCII "$env:TEMP\clover-eval-bootstrap.js"
node "$env:TEMP\clover-eval-bootstrap.js"
```

O bootstrap Node:

1. registra branch/SHA atuais;
2. exige Git limpo, `banco.sqlite`, `auth_info` e `clover-rpg` online;
3. interpreta `pm2 jlist` diretamente no Node, sem parser JSON do PowerShell 5.1;
4. confirma que `clover-rpg` aponta para este repo;
5. busca a branch remota;
6. para `clover-rpg` **antes de qualquer checkout**;
7. cria backup SQLite verificado no estado antigo;
8. troca para `clover/evaluation-support-migration-2026-10-13`;
9. valida o histórico aplicado `31–54` contra as atestações pinadas;
10. aplica migrations `55–58` com a feature ainda OFF;
11. exige `user_version = 58` e `integrity_check = ok`;
12. sobe `clover-rpg` novamente com a fila universal OFF;
13. roda diagnóstico do runtime.

Se alguma etapa falhar depois da parada do runtime, o bootstrap tenta:

- parar o PM2;
- restaurar o SQLite pré-checkout;
- restaurar branch/SHA anteriores;
- reiniciar o runtime anterior com features novas OFF.

O bootstrap Node é ASCII-only para não depender de codepage/encoding do PowerShell 5.1.

## 2. Estado esperado depois do bootstrap

```text
PM2 clover-rpg: online
SQLite user_version: 58
Migrations novas: 55, 56, 57, 58
CLOVER_UNIVERSAL_EVALUATION: 0
auth_info: preservado
fluxo legado de Feitiços: ainda existente
fila universal: instalada, mas inativa
```

Antes de ligar a feature, confirmar rapidamente:

- WhatsApp reconectou sem QR novo;
- comandos normais respondem;
- site/API local está saudável;
- `.#fichaavaliacao` / `.#modeloavaliacao` continuam entregando a Ficha de Avaliação de Cena.

## 3. Ativar somente a fila universal

Depois do smoke test legado:

```powershell
node .\scripts\toggleUniversalEvaluationLocal.js --enable --confirm=ENABLE_UNIVERSAL_EVALUATION_LOCAL
```

Antes de ligar, o script revalida:

- branch e Git limpos;
- PM2 `clover-rpg` online e apontando para este repo;
- SQLite íntegro;
- migrations `55–58` presentes;
- `PRAGMA user_version = 58`.

Se o enable não puder ser comprovado online, ele solicita rollback automático para `CLOVER_UNIVERSAL_EVALUATION=0`.

**Não executa `pm2 save`.**

## 4. Smoke test da fila universal

### Feitiço

1. `.#fichafeitico`
2. player preenche somente campos próprios;
3. reply com `.#enviarfeitico`;
4. ADM: `.#avaliacoes`;
5. ADM: `.#avaliacao #A...`;
6. ADM preenche a ficha final;
7. `.#aprovar #A...` + ficha final, ou `.#negar #A... motivo`.

Validar também:

- múltiplas submissões do mesmo player;
- protocolo permanente mesmo com posição mudando;
- update de Feitiço não consumindo slot novo;
- Feitiço novo com slot cheio sendo bloqueado sem perder submissão.

### Protótipo Humano

1. `.#fichaprototipo`
2. player preenche Nome + Ideia e deixa Defeito para ADM;
3. `.#enviarprototipo`;
4. mesma fila universal;
5. ADM define Defeito e aprova.

Validar limite do estágio e bloqueio para não-Humano.

## 5. Rollback comportamental imediato

Se o fluxo novo estiver errado:

```powershell
node .\scripts\toggleUniversalEvaluationLocal.js --disable --confirm=DISABLE_UNIVERSAL_EVALUATION_LOCAL
```

Isso desliga a fila universal e reinicia `clover-rpg`. As migrations/tabelas permanecem no banco, mas ficam inertes para o fluxo novo.

## Modo manual interno

Os scripts abaixo continuam disponíveis para diagnóstico ou recuperação controlada:

```powershell
node .\scripts\preflightUniversalEvaluationLocal.js --backup --require-stopped
node .\scripts\applyUniversalEvaluationLocal.js --confirm=APPLY_UNIVERSAL_EVALUATION_LOCAL
```

O apply manual **exige `clover-rpg` parado**.

## Fora deste checkpoint

- nenhum `pm2 save`;
- nenhum merge no `main`;
- nenhum corte da fila legada de Feitiços;
- nenhum desligamento do scheduler legado (Gate 5);
- nenhum Suporte novo (Gate 6);
- nenhuma limpeza de AntiGhost/legados (Gate 8);
- nenhuma alteração de `auth_info`.
