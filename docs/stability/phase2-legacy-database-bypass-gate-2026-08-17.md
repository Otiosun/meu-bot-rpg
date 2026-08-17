# FASE 2 — gate de bypass do database/legacy

Data: 17/08/2026

## Objetivo

Antes de remover os 53 `ensureColumn()` já cobertos pelas migrations 0002→0008, provar que nenhum código de produção bypassa o wrapper canônico `database.js` e executa `database/legacy.js` diretamente.

O pre-bootstrap canônico depende dessa propriedade: bancos não adotados recebem tabelas-base + migrations schema-safe antes do legacy; bancos adotados recebem migrations pendentes antes do legacy. Um callsite direto ao legacy quebraria essa garantia.

## Evidência histórica

O ZIP completo do runtime anterior à separação do legacy foi escaneado em arquivos de código/config/docs não sensíveis:

- `database/legacy`: 0 ocorrências;
- `legacyDatabase`: 0 ocorrências;
- `createLegacyDatabase`: 0 ocorrências.

Portanto todas as referências ao módulo separado precisam ter surgido depois do split.

Compare histórico completo de `a2203afe711a1b481250b894139fc2cdcd4b6008` até `a090b957d41d9492eee673755ae64d5333892991` cobre 12 commits da fundação. Os imports diretos introduzidos são exatamente:

1. `database.js` → `require('./database/legacy')`: ponte canônica de produção;
2. `tests/databaseMigrationCatalog.test.js` → `require('../database/legacy')`: fixture de teste explicitamente allowlisted.

Não foi encontrado terceiro import direto em helper, comando, site API, worker, script de produção ou domínio.

`createLegacyDatabase` aparece no wrapper e em fixtures de teste como ponto de injeção controlado; o gate bloqueia object-literal `createLegacyDatabase:` em código fora de `tests/`.

## Auditor versionado

`helpers/clover/legacyDatabaseBypassAudit.js`:

- percorre `.js/.cjs/.mjs` recursivamente;
- ignora `.git`, `node_modules`, `auth_info`, caches/build/logs;
- detecta `require`, dynamic `import()` e `import/export ... from` direcionados a `database/legacy`;
- exige exatamente a ponte de produção `database.js → ./database/legacy`;
- permite import direto de teste somente em `tests/databaseMigrationCatalog.test.js`;
- bloqueia `legacyDatabase.criarBanco` em produção fora de `database.js`;
- bloqueia `createLegacyDatabase:` em código de produção;
- falha também se a ponte canônica esperada desaparecer.

`scripts/auditCloverLegacyDatabaseBypass.js` executa o gate no checkout e emite JSON somente leitura.

## Gate local

Fixture + parser + fail-closed:

- `node --check`: PASS;
- `node --test tests/legacyDatabaseBypassAudit.test.js`: **6/6 PASS**;
- caso permitido: 1 import produção + 1 import teste;
- import em helper de produção: bloqueado;
- `createLegacyDatabase:` em produção: bloqueado;
- ponte canônica ausente: bloqueado;
- parser cobre require/import()/from.

O teste possui também um caso de checkout completo: exige exatamente 2 imports diretos, sendo 1 produção e 1 teste.

## Segurança

- somente leitura;
- nenhum SQLite é aberto;
- nenhum schema é alterado;
- nenhum `database.js`/`database/legacy.js` é modificado por este gate;
- nenhum deploy/restart/PM2/Mudzap/live DB;
- dados de jogadores não são lidos.

## Próximo gate

Se o auditor passar no `main`, a pré-condição de bypass fica fechada. O próximo trabalho pode ser a **remoção mecânica dos 53 `ensureColumn()` cobertos**, mantendo índices/seeds/normalizações no legacy e provando:

1. banco vazio;
2. upgrade antigo não adotado;
3. banco já adotado;
4. snapshot real;
5. segunda inicialização no-op;
6. diff estritamente limitado às 53 chamadas removidas + atualização do gate.
