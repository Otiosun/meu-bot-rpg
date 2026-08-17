# Clover RPG — Fundação de banco reproduzível da FASE 1

Data: 17/08/2026

## Gate desta mudança

Esta etapa introduz a infraestrutura mínima para retirar, de forma gradual, o schema do bootstrap implícito de runtime.

Ela **não executa migration no Windows live**, não troca o arquivo `banco.sqlite`, não reinicia PM2/Mudzap e não remove o DDL legado de `database.js` de uma vez.

## Mudanças

1. `helpers/clover/databaseConnection.js`
   - concentra a configuração canônica da conexão SQLite e já oferece o opener que será usado na retirada gradual do legado;
   - `busy_timeout=10000` por padrão;
   - `foreign_keys=ON` por padrão e verificado fail-closed;
   - WAL permanece explícito no caminho normal.
2. `helpers/clover/schemaMigrationService.js`
   - ledger autoritativo `clover_schema_migrations`;
   - versões monotônicas;
   - checksum por migration;
   - transação `BEGIN IMMEDIATE` por migration;
   - rollback em falha;
   - recheck dentro da transação para tolerar corrida de startup já resolvida;
   - schema fingerprint excluindo somente o próprio ledger;
   - `PRAGMA user_version` espelha a última migration aplicada.
3. `database.js` + `database/legacy.js`
   - o antigo `database.js` é preservado byte a byte como `database/legacy.js`;
   - o novo `database.js` vira o ponto canônico de bootstrap para todos os imports existentes;
   - mantém compatibilidade com `criarBanco()` sem argumentos e reexporta todos os `ensure*`;
   - após o bootstrap legado, ativa/valida a configuração canônica e executa o migrator central;
   - o opener interno do legado ainda será retirado progressivamente, sem big-bang rewrite.
4. Migration `0001_baseline_adoption`
   - não recria tabelas de domínio;
   - adota o schema existente e registra o fingerprint;
   - permite transição incremental das superfícies DDL já identificadas.

## Validação isolada

### Testes unitários/contratuais

`tests/databaseReproducibility.test.js`: **6/6 PASS**.

Cobertura:
- conexão canônica liga FK/WAL/busy timeout;
- FK é realmente aplicada em escrita inválida;
- baseline adoption é idempotente;
- fingerprint de domínio não muda só pela criação do ledger;
- recheck transacional tolera migration que acabou de ser aplicada;
- checksum adulterado falha fechado;
- DDL de migration que lança erro sofre rollback e não ganha entrada no ledger.

### Banco vazio

Em arquivo temporário novo:
- primeira inicialização: 69 tabelas, FK=1, `quick_check=ok`, 1 migration;
- segunda inicialização: mesmos valores;
- nenhum crescimento de ledger na repetição.

### Cópia do snapshot real da FASE 0

Origem usada apenas como fonte de cópia: snapshot SHA-256 já registrado na FASE 0.

Antes:
- 169 tabelas;
- 471430 linhas agregadas;
- `quick_check=ok`;
- `integrity_check=ok`;
- `foreign_key_check=0`;
- `user_version=0`.

Após primeira inicialização da candidata:
- 170 tabelas;
- a única tabela nova é `clover_schema_migrations`;
- **nenhuma tabela preexistente mudou de contagem de linhas**;
- `quick_check=ok`;
- `integrity_check=ok`;
- `foreign_key_check=0`;
- conexão canônica com FK=1;
- WAL preservado;
- `user_version=1`;
- migration aplicada: `0001_baseline_adoption`.

Após segunda inicialização:
- mesmas 170 tabelas;
- mesmas contagens agregadas;
- mesmo fingerprint de schema de domínio;
- exatamente uma entrada no ledger;
- `user_version=1`.

## A/B de falhas fora do delta

Uma rodada mais ampla encontrou duas falhas já existentes no laboratório:

- `tests/databaseLifecycleGuard.test.js`: caso de timeout fica pendente/cancelado no runner;
- `tests/economyFoundation.test.js`: teste temporal retorna `event_not_active` na data atual.

Os dois testes foram repetidos contra a baseline sem esta mudança de banco e falharam da mesma forma. Portanto não são classificados como regressão desta candidata e não serão corrigidos misturados neste PR.

## Limite deliberado

O DDL legado ainda existe e continua sendo executado antes do migrator. Isso é temporário e necessário para compatibilidade. A retirada dessas superfícies deve ocorrer por migrations explícitas, em lotes pequenos, com snapshot/preflight/rollback e testes em banco vazio + snapshot real.

**Este gate cria a fundação; não autoriza deploy no live.**
