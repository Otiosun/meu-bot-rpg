# Runbook de manutencao do banco vivo

Este runbook define o procedimento minimo para qualquer operacao autorizada no
`banco.sqlite` vivo. Ele nao autoriza execucao por si so.

Banco padrao:

```text
C:\Users\natan\Documents\meu-bot-rpg\banco.sqlite
```

## Quando usar

Use este runbook para:
- instalacao de schema;
- migration idempotente;
- reparo controlado;
- aplicacao de lote operacional;
- rollback de banco.

Nao use para:
- testes destrutivos;
- seed demonstrativo;
- simulacoes que podem rodar em copia isolada;
- investigacao comum de leitura.

## Pre-flight obrigatorio

1. Confirmar autorizacao humana explicita para tocar o banco vivo.
2. Confirmar branch e SHA esperados.
3. Confirmar `git status --short --branch` sem arquivos rastreados alterados.
4. Confirmar que o script pertence ao SHA autorizado.
5. Confirmar PM2 e identificar o processo real do Clover.
6. Confirmar health local com fila livre:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
```

Resultado esperado:
- `ok=true`;
- `queue.depth=0`;
- `queue.active=false`.

Se a fila estiver ativa, aguarde ou pare.

## Copia isolada antes do vivo

Antes de escrever no banco vivo, rode em copia quando o script permitir:

```powershell
npm run <script> -- --db="CAMINHO_DA_COPIA"
```

ou modo preview:

```powershell
npm run <script-preview> -- --db="CAMINHO_DA_COPIA"
```

Somente avance se:
- preview bate com o plano esperado;
- auditoria da copia esta saudavel;
- nao ha achados criticos inesperados.

## Backup consistente

Backup deve acontecer antes da primeira escrita no banco original.

Preferencia:
- helper `helpers/clover/sqliteBackupService.js`;
- ou script operacional que use `VACUUM INTO`.

Padrao manual de conferencia apos backup:

```powershell
Get-Item "CAMINHO_DO_BACKUP" | Select-Object FullName,Length
Get-FileHash "CAMINHO_DO_BACKUP" -Algorithm SHA256
```

Condições:
- arquivo existe;
- tamanho maior que zero;
- SHA-256 registrado no relatorio;
- caminho fica em `backups/` ou pasta aprovada fora do Git.

## Parada controlada

Quando a operacao exige exclusividade:

1. Identificar o processo real:

```powershell
pm2 list
pm2 jlist
```

2. Parar somente o processo confirmado, por nome ou id.
3. Nao usar `pm2 delete`.
4. Nao parar `mudzap` nem `mudzap-ngrok`.
5. Confirmar que nao ha bot duplicado.

Se a operacao puder rodar com o bot online, isso deve estar documentado no
script/PR.

## Execucao

Use sempre caminho explicito de banco:

```powershell
npm run <script> -- --db="C:\Users\natan\Documents\meu-bot-rpg\banco.sqlite" --allow-live-write
```

O script deve imprimir:
- SHA do codigo;
- caminho do banco;
- caminho do backup;
- plano ou tabelas afetadas;
- totais antes/depois quando aplicavel;
- resultado da auditoria;
- instrucao de rollback.

Pare diante de:
- SHA diferente do autorizado;
- backup ausente;
- erro de SQLite;
- auditoria critica;
- totais incompatíveis;
- script criando seed ou conteudo demonstrativo quando nao autorizado.

## Verificacao independente

Depois da execucao, rode checagem somente leitura apropriada:

```powershell
node scripts/<audit>.js --db="C:\Users\natan\Documents\meu-bot-rpg\banco.sqlite" --output="CAMINHO_JSON"
```

E integrity check:

```powershell
node -e "const sqlite3=require('sqlite3'); const db=new sqlite3.Database('banco.sqlite', sqlite3.OPEN_READONLY); db.get('PRAGMA integrity_check', (e,r)=>{ if(e) throw e; console.log(r); db.close(); });"
```

Resultado esperado:
- `integrity_check = ok`;
- auditoria saudavel;
- zero criticos, salvo excecao aprovada e documentada.

## Reinicio e health

Se o processo foi parado:

```powershell
pm2 restart <NOME_OU_ID_CONFIRMADO>
pm2 list
pm2 logs <NOME_OU_ID_CONFIRMADO> --lines 80 --nostream
```

Confirmar:
- exatamente uma instancia;
- status `online`;
- sem erro de schema;
- sem erro de abertura SQLite;
- sem loop de restart.

Health local:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
```

Health publico somente se a operacao afetar API/site ou se a janela exigir.

## Rollback

Rollback de banco so deve ocorrer com falha confirmada e autorizacao da janela.

Antes de restaurar:
1. Parar somente `clover-rpg`, se necessario.
2. Preservar o banco atual defeituoso como evidencia.
3. Registrar hash do banco defeituoso.
4. Restaurar backup aprovado.
5. Rodar `PRAGMA integrity_check`.
6. Reiniciar somente `clover-rpg`.
7. Confirmar health local e logs.

Nunca restaurar backup por palpite se a falha puder ser corrigida por script
idempotente e validado.

## Modelo de relatorio

```text
SHA:
Branch:
Banco:
Backup:
SHA-256 do backup:
Processo PM2:
Script executado:
Auditoria:
Integrity check:
Totais antes/depois:
Health local:
Health publico:
Rollback disponivel:
Avisos:
Conclusao:
```

Conclusoes aceitas:
- `MANUTENCAO CONCLUIDA`;
- `ROLLBACK NECESSARIO`;
- `BLOQUEADO`.

## Proibicoes

- Nao usar banco vivo para teste.
- Nao rodar seed sem autorizacao explicita.
- Nao criar conteudo demonstrativo em producao.
- Nao usar `git reset`, `git clean`, `prune` ou force para "organizar" antes
  de operacao.
- Nao versionar backups, banco, `.env`, tokens ou sessoes.
- Nao tocar MudZap, MudZap-ngrok ou WhatsApp.
