# Clover RPG — Auditoria de reprodutibilidade do banco (FASE 1)

Data: 17/08/2026

## Escopo e segurança

Auditoria executada exclusivamente sobre o snapshot consistente `banco-fase0.sqlite`. Nenhuma consulta expôs conteúdo de jogadores, JID/LID, telefone, token, código de login ou payload privado. Nenhuma escrita foi realizada no banco vivo ou no snapshot usado como evidência.

- backend `main` revalidado: `9533bcebaae202cb15da10592c2eded15a98164a`
- SHA-256 do snapshot: `45952a05fd9aee1518bb6e575029681f405fd55e4df9981fadbcb78c3a0f1ed6`
- tamanho: 176050176 bytes
- `quick_check`: `ok`
- `integrity_check`: `ok`
- `foreign_key_check`: 0 violações
- journal: `WAL`

## Estado do schema real

- 169 tabelas
- 211 índices
- 13 triggers
- 0 views
- todas as 169 tabelas possuem chave primária
- 30 relações FK distribuídas por 26 tabelas
- 8 relações FK não possuem índice iniciando pelas colunas filhas
- `PRAGMA user_version = 0`
- `PRAGMA schema_version = 1` é contador interno do SQLite e não substitui versionamento de migrations

## Problema de reprodutibilidade confirmado

O `database.js` do ZIP, após normalização CRLF→LF, possui blob Git `e1d1be88262a3a88b11e13d13af7a4b2ad1b6435`, exatamente o `database.js` do `main` atual.

Esse arquivo sozinho contém:

- 68 `CREATE TABLE IF NOT EXISTS`;
- 125 chamadas de `ensureColumn(...)`;
- migração in-place de `slot_reservations` por rename/cópia/drop;
- DDL executado durante `criarBanco()`.

Além dele, o código de produção do `main` possui aproximadamente 61 helpers adicionais que podem criar ou alterar schema. Portanto existem **62 superfícies de produção que podem executar DDL**, sem um ledger central de migrations.

O bootstrap principal configura `busy_timeout` e `journal_mode=WAL`, mas **não ativa `PRAGMA foreign_keys=ON`**. Como essa configuração é por conexão no SQLite, as FKs existentes não são garantidas pelo caminho normal de escrita da aplicação.

## Evidência de schema dependente do histórico de uso

A análise estática encontrou 150 tabelas literais declaradas pelo código de produção disponível do `main`. Cinco delas não existem no snapshot atual:

- `clover_player_lifecycle_undos`
- `clover_raid_creation_requests`
- `clover_raid_mutation_requests`
- `clover_squad_membership_transitions`
- `clover_trait_duplicate_anomaly_migrations`

Todas são criadas por `ensure*Schema()` chamado por fluxos específicos. A ausência não é corrupção; ela prova que o formato físico do banco depende de quais funcionalidades já foram executadas.

O snapshot possui ainda 23 tabelas que não aparecem em um `CREATE TABLE IF NOT EXISTS <nome literal>` no conjunto de produção analisado; parte é criada por nomes dinâmicos e parte pertence a reparos/migrações históricas. Isso precisa ser classificado antes de qualquer política de limpeza. **Nenhuma tabela será removida nesta fase.**

## Invariantes agregadas

Sem expor identidades:

- sessões totais: 301
- sessões ativas e não expiradas: 110
- jogadores com mais de 5 sessões ativas: 0
- máximo observado de sessões ativas por jogador: 3
- sessões ativas ligadas diretamente a cadastro hoje inelegível: 6
- memberships canônicos ativos: 33
- jogadores com mais de um membership canônico ativo: 0
- jobs de delivery: 342 total / 18 pending / 59 failed / 0 em processamento
- 224 colunas explicitamente JSON/payload foram verificadas: 0 valores JSON inválidos

As 6 sessões em linhas hoje inelegíveis não demonstram bypass: o hotfix live revalida elegibilidade ao autenticar e revoga a sessão nesse caminho. Elas indicam apenas que a tabela pode conservar tokens ainda não reutilizados após a mudança de estado do jogador.

## Pressão de armazenamento observada

As tabelas `clover_antighost_events` e `clover_antighost_messages` somam 449835 de 471430 linhas (95,4% das linhas contadas).

Pelo `dbstat`, as maiores estruturas são:

- `clover_antighost_messages`: ~46,0 MiB
- `clover_antighost_events`: ~41,0 MiB
- índice de events por player: ~21,5 MiB
- autoindex de messages: ~19,5 MiB

Isso não é um P0 de integridade, mas deve entrar posteriormente em retenção/observabilidade.

## Oito FKs sem índice filho correspondente

1. `clover_economy_listings.template_key → clover_item_templates.template_key`
2. `clover_economy_purchase_intents.listing_key → clover_economy_listings.listing_key`
3. `clover_performance_teams.cycle_id → clover_performance_cycles.id`
4. `clover_pr_ledger.event_id → clover_recruitment_events.id`
5. `clover_pr_shop_purchases.pr_ledger_id → clover_pr_ledger.id`
6. `clover_recruitment_group_submissions.ledger_id → clover_pr_ledger.id`
7. `clover_recruitment_group_submissions.event_id → clover_recruitment_events.id`
8. `clover_role_grant_events.grant_id → clover_role_grants.id`

Não criar índices automaticamente. Primeiro medir consultas e confirmar o contrato de cada relação; depois versionar via migration explícita.

## Decisão arquitetural

A FASE 1 não fará `reset`, não reconstruirá o live e não aplicará migrations nele.

O gate para produção reproduzível passa a exigir:

1. um único inicializador de conexão SQLite;
2. `foreign_keys=ON` no caminho normal de aplicação, validado em cópia do snapshot;
3. um migrator central com IDs monotônicos, checksum e transação;
4. tabela `clover_schema_migrations` como ledger autoritativo;
5. `user_version` apenas como espelho numérico do último migration;
6. baseline-adoption da base existente, sem recriar 169 tabelas;
7. schema fingerprint antes/depois;
8. migrations idempotentes em banco vazio e no snapshot real;
9. `quick_check`, `integrity_check` e `foreign_key_check` após cada gate;
10. progressiva remoção de DDL dos read paths/services, mantendo compatibilidade durante a transição;
11. nenhum migration destrutivo sem snapshot, preflight e caminho de rollback/forward;
12. teste separado da atualização do SQLite 3.51.2 antes de qualquer troca do runtime.

## Gate atual

**FASE 0: PASS.**

**FASE 1: EM EXECUÇÃO.**

Este audit fecha a descoberta do banco necessária à FASE 1, mas não autoriza avançar formalmente à FASE 2 enquanto a convergência dos hotfixes do runtime e a candidata reproduzível não estiverem versionadas e testadas.
