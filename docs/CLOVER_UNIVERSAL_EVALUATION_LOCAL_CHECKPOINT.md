# Clover — checkpoint local da fila universal

Este runbook aplica **Gates 1–4** no runtime local sem cortar o fluxo legado de Feitiços.

## Garantias deste checkpoint

- `auth_info/` não é alterado pelos scripts.
- `CLOVER_UNIVERSAL_EVALUATION` começa e permanece **OFF** durante o apply de schema.
- migrations novas são aditivas (`31–34`).
- o backup SQLite é criado e validado antes do apply.
- o PM2 só é reiniciado **depois** de as migrations e o `integrity_check` passarem.
- `pm2 save` não é executado; o enable é um checkpoint reversível.
- `CLOVER_STRICT_COMMAND_OWNERSHIP` permanece OFF porque há colisões legadas conhecidas que serão removidas no Gate 5/8.

## 0. Atualizar a branch local

No PowerShell, dentro do repo do Clover:

```powershell
git fetch origin
git switch clover/evaluation-support-migration-2026-10-13
git pull --ff-only origin clover/evaluation-support-migration-2026-10-13
```

Trocar de branch **não reinicia o processo PM2**. O bot que já está em memória continua executando até o restart controlado.

## 1. Preflight + backup somente leitura

```powershell
$env:CLOVER_UNIVERSAL_EVALUATION="0"
node .\scripts\preflightUniversalEvaluationLocal.js --backup
```

O preflight bloqueia se detectar, entre outros:

- Node abaixo de 24;
- branch errada;
- Git sujo;
- `auth_info` ausente;
- `banco.sqlite` ausente/corrompido;
- PM2 `clover-rpg` ausente/offline ou apontando para outro cwd;
- fila universal ligada no shell ou no ambiente do PM2.

O comando **não migra, não reinicia e não toca em auth**.

## 2. Apply local com feature ainda OFF

```powershell
node .\scripts\applyUniversalEvaluationLocal.js --confirm=APPLY_UNIVERSAL_EVALUATION_LOCAL
```

Fluxo interno:

1. repete preflight e cria novo backup verificado;
2. exige migration ledger coerente entre v30 e v34;
3. aplica/reconcilia migrations 31–34;
4. exige `PRAGMA user_version = 34`;
5. roda `PRAGMA integrity_check`;
6. reinicia `clover-rpg` com `CLOVER_UNIVERSAL_EVALUATION=0`;
7. roda diagnóstico do runtime.

Se migration falhar, o PM2 **não é reiniciado**. O runtime que já estava em memória continua ativo.

## 3. Smoke test ainda com fila OFF

Antes de ligar a feature, confirmar que o bot continua respondendo normalmente e que:

- sessão WhatsApp continua conectada;
- comandos antigos não quebraram;
- site/API local continua saudável;
- `.#fichaavaliacao` / `.#modeloavaliacao` continuam entregando a ficha de Avaliação de Cena.

## 4. Ativar somente a fila universal

```powershell
node .\scripts\toggleUniversalEvaluationLocal.js --enable --confirm=ENABLE_UNIVERSAL_EVALUATION_LOCAL
```

O script só liga se as migrations 31–34 estiverem presentes. Se não conseguir comprovar o processo online com a flag `1`, solicita rollback automático para OFF.

**Não executa `pm2 save`.**

## 5. Smoke test do fluxo novo

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
- posição global mudando sem quebrar protocolo;
- update de Feitiço não consumindo slot novo;
- Feitiço novo com slot cheio sendo bloqueado sem perder submissão.

### Protótipo Humano

1. `.#fichaprototipo`
2. player preenche Nome + Ideia e deixa Defeito para ADM;
3. `.#enviarprototipo`;
4. mesma fila universal;
5. ADM define Defeito e aprova.

Validar limite do estágio e bloqueio para não-Humano.

## 6. Rollback comportamental imediato

Se qualquer coisa no fluxo novo estiver errada:

```powershell
node .\scripts\toggleUniversalEvaluationLocal.js --disable --confirm=DISABLE_UNIVERSAL_EVALUATION_LOCAL
```

Isso desliga a fila universal e reinicia `clover-rpg`. As migrations/tabelas permanecem no banco, mas ficam inertes para o fluxo novo. Não há necessidade de restaurar o SQLite apenas para desligar a feature.

## Fora deste checkpoint

- nenhum `pm2 save`;
- nenhum merge no `main`;
- nenhum corte da fila legada de Feitiços;
- nenhum desligamento do scheduler legado (Gate 5);
- nenhum Suporte novo (Gate 6);
- nenhuma limpeza de AntiGhost/legados (Gate 8);
- nenhuma alteração de `auth_info`.
