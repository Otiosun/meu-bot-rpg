# Fase 0 — Evidência e contenção

## Objetivo

Produzir uma fotografia reproduzível do código e do banco vivo antes de qualquer migração, correção econômica ou reconstrução de UX.

Esta fase não escolhe automaticamente qual tabela “vence”, não corrige linhas e não ativa PRs P0. Ela transforma divergências em evidência verificável.

## Baseline observada em 31/07/2026

A observação abaixo veio do GitHub, não do processo PM2 nem do diretório implantado:

- backend `main`: `60b1af1685dd83ef8f234f030da914d98b5a2379`;
- frontend `main`: `788ced98c0e67987490507fe2c01c083243ad1b5`;
- PR backend #137 em rascunho, baseada em `71c57e4c5ea007ea4209027cfa757e2035bbda44`;
- PR backend #138 em rascunho, baseada em `71c57e4c5ea007ea4209027cfa757e2035bbda44`;
- PR frontend #98 em rascunho, baseada em `2b32873670d6da4418622144bd7d0170c5eb3666`.

Esses valores não provam qual SHA está rodando em produção. Essa confirmação precisa ser extraída do diretório e processo reais.

## Duas evidências de código diferentes

A Fase 0 registra dois SHAs que não devem ser confundidos:

- **SHA do runtime observado:** código que o processo real estava executando;
- **SHA do auditor:** código que gerou snapshot e relatório.

Um worktree seguro da branch auditora normalmente terá SHA diferente do runtime. Portanto, o SHA implantado é registrado por `--runtime-sha`, enquanto `--expected-auditor-sha` valida apenas o checkout do auditor.

## Regra de segurança

Antes de qualquer escrita:

1. confirmar o diretório usado pelo PM2;
2. registrar o SHA desse diretório;
3. criar snapshot consistente do SQLite;
4. verificar o snapshot com `PRAGMA integrity_check`;
5. executar a auditoria no banco original em modo somente leitura;
6. preservar relatório, snapshot e os dois SHAs juntos.

Não usar cópia simples do arquivo enquanto o processo estiver escrevendo no SQLite. O projeto já possui `sqliteBackupService`, que usa `node:sqlite.backup()` e verifica a integridade do destino.

## Entregas da Fase 0

```text
scripts/createCloverPhase0Snapshot.js
scripts/auditCloverPhase0.js
scripts/auditLegacySquadReconcileCallsites.js
tests/cloverPhase0Audit.test.js
docs/clover/phase0-host-execution.md
```

## Garantias do auditor read-only

- abre o SQLite com `OPEN_READONLY`;
- força e confirma `PRAGMA query_only = ON`;
- executa `PRAGMA integrity_check`;
- executa `PRAGMA foreign_key_check`;
- registra modo de journal;
- não chama funções `ensure*`, migrações ou instaladores;
- não cria tabela, índice ou trigger;
- não atualiza dados;
- gera JSON com digest SHA-256 da evidência;
- pode falhar com código `2` quando houver bloqueios críticos.

## Execução resumida

### Snapshot consistente

```bash
node scripts/createCloverPhase0Snapshot.js \
  --db=/CAMINHO/REAL/banco.sqlite \
  --runtime-sha=<SHA_OBSERVADO_NO_PM2_CWD> \
  --expected-auditor-sha=<SHA_DA_BRANCH_AUDITORA> \
  --output=./backups/clover-phase0-producao.sqlite \
  --metadata=./backups/clover-phase0-producao.metadata.json
```

### Pontos de chamada do reconciliador

```bash
node scripts/auditLegacySquadReconcileCallsites.js \
  --root=. \
  --output=./backups/clover-phase0-reconcile-callsites.json
```

### Auditoria read-only

```bash
node scripts/auditCloverPhase0.js \
  --db=/CAMINHO/REAL/banco.sqlite \
  --runtime-sha=<SHA_OBSERVADO_NO_PM2_CWD> \
  --expected-auditor-sha=<SHA_DA_BRANCH_AUDITORA> \
  --output=./backups/clover-phase0-producao.json \
  --fail-on-critical
```

O código de saída é:

- `0`: execução concluída; sem trava solicitada ou sem críticos;
- `1`: erro de execução;
- `2`: execução concluída, mas a trava encontrou bloqueios.

## Evidências coletadas

### Implantação e auditor

- SHA observado no diretório do runtime;
- SHA, branch e `origin/main` do auditor;
- alterações não commitadas no auditor;
- validação opcional do SHA esperado do auditor.

### Banco

- caminho, tamanho e data de modificação;
- confirmação de `query_only`;
- `integrity_check`;
- `foreign_key_check`;
- modo de journal;
- inventário de tabelas e colunas.

### Estados reais

- valores distintos e contagem de `ficha_status`;
- valores distintos e contagem de `jogo_status`.

### Cargos e permissões

- cargos ativos em `clover_admin_roles`;
- concessões ativas em `clover_access_roles`;
- cargo da Central sem concessão operacional equivalente;
- concessão operacional sem cargo equivalente na Central;
- Auxiliar sem equivalente operacional explícito.

### Personagens e esquadrões

- vínculos ativos duplicados;
- vínculo sem personagem;
- vínculo sem esquadrão;
- divergência entre `clover_squad_memberships` e `jogadores.esquadrao`;
- campo legado preenchido sem vínculo ativo;
- membro ativo fora da política atual de ficha/jogo;
- Capitão registrado sem personagem;
- Capitão registrado sem concessão escopada correspondente.

### Estrelas

- lançamentos com `source = squad_reconcile`;
- lançamentos negativos que exigem classificação semântica;
- agregados negativos;
- histórico vitalício abaixo do saldo atual;
- inventário das tabelas relacionadas a Estrelas e temporadas.

O relatório não presume que “valor positivo = histórico”. Ele apenas registra os dados existentes para classificação posterior.

### Operações administrativas

- contagem por estado;
- operações `partially_applied`;
- unidades órfãs;
- unidade já mutada com operação-pai em estado incompatível.

### Raids, recompensas e propostas

- inventário de tabelas relacionadas;
- quantidade de registros;
- estados;
- colunas de hash/fingerprint/digest;
- colunas de versão.

Essa parte é evidência estrutural. A cobertura exata do hash ainda precisa ser verificada no código e em testes de adulteração.

## Privacidade da evidência

O banco e os relatórios podem conter IDs, vínculos, cargos e dados econômicos. Devem permanecer em `backups/` ou outro diretório restrito e ignorado pelo Git. Nunca anexar o banco vivo nem relatórios crus em PRs públicos.

## Critérios para encerrar a Fase 0

- [ ] SHA realmente implantado registrado para backend e frontend;
- [ ] SHA do auditor registrado;
- [ ] snapshot consistente criado, validado e identificado por SHA-256;
- [ ] auditor executado contra o banco vivo;
- [ ] auditor repetido contra o snapshot;
- [ ] relatório e digest preservados;
- [ ] todos os críticos classificados como dado real, defeito de código, dívida de migração ou falso positivo comprovado;
- [ ] reconciliador legado identificado em todos os pontos de chamada;
- [ ] rotina perigosa bloqueada antes de qualquer migração;
- [ ] PRs #137, #138 e #98 atualizadas contra os `main` atuais ou substituídas;
- [ ] plano de migração gerado a partir da evidência real.

## Ordem posterior

1. contenção explícita do reconciliador e de ajustes negativos;
2. fonte canônica de cargos e permissões;
3. ledger semântico com efeitos separados;
4. versões imutáveis e hash completo das propostas;
5. recuperação de operações parciais;
6. personagem, mandato de Capitão e vínculo canônicos;
7. somente então reconstrução dos fluxos e da UX.
