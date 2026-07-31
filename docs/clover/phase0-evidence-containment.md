# Fase 0 — Evidência e contenção

## Objetivo

Produzir uma fotografia reproduzível do código e do banco vivo antes de qualquer migração, correção econômica ou reconstrução de UX.

Esta fase não escolhe automaticamente qual tabela “vence”, não corrige linhas e não ativa PRs P0. Ela transforma divergências em evidência verificável.

## Baseline observada em 31/07/2026

A observação abaixo veio do GitHub, não do processo PM2 nem do diretório implantado:

- backend `main`: `60b1af1685dd83ef8f234f030da914d98b5a2379`;
- frontend `main`: `788ced98c0e67987490507fe2c01c083243ad1b5`;
- PR backend #137 ainda em rascunho, baseada em `71c57e4c5ea007ea4209027cfa757e2035bbda44`;
- PR backend #138 ainda em rascunho, baseada em `71c57e4c5ea007ea4209027cfa757e2035bbda44`;
- PR frontend #98 ainda em rascunho, baseada em `2b32873670d6da4418622144bd7d0170c5eb3666`.

Esses valores não provam qual SHA está rodando em produção. Essa confirmação precisa ser extraída do diretório e processo reais.

## Regra de segurança

Antes de qualquer escrita:

1. confirmar o diretório usado pelo PM2;
2. registrar o SHA desse diretório;
3. criar snapshot consistente do SQLite;
4. verificar o snapshot com `PRAGMA integrity_check`;
5. executar a auditoria no banco original em modo somente leitura;
6. preservar relatório, snapshot e SHA juntos.

Não usar cópia simples do arquivo enquanto o processo estiver escrevendo no SQLite. O projeto já possui `sqliteBackupService`, que usa `node:sqlite.backup()` e verifica a integridade do destino.

## Auditor read-only

Arquivo:

```text
scripts/auditCloverPhase0.js
```

Garantias implementadas:

- abre o SQLite com `OPEN_READONLY`;
- força e confirma `PRAGMA query_only = ON`;
- executa `PRAGMA integrity_check`;
- não chama funções `ensure*`, migrações ou instaladores;
- não cria tabela, índice ou trigger;
- não atualiza dados;
- gera JSON com digest SHA-256 da evidência;
- pode falhar com código `2` quando houver bloqueios críticos.

## Execução

No mesmo diretório e checkout usados pelo runtime:

```bash
node scripts/auditCloverPhase0.js \
  --db=./banco.sqlite \
  --expected-sha=<SHA_CONFIRMADO_NO_RUNTIME> \
  --output=./backups/phase0-audit-producao.json
```

Para CI, validação ou trava operacional:

```bash
node scripts/auditCloverPhase0.js \
  --db=./banco.sqlite \
  --expected-sha=<SHA_CONFIRMADO_NO_RUNTIME> \
  --output=./backups/phase0-audit-producao.json \
  --fail-on-critical
```

O código de saída é:

- `0`: auditoria executada; sem trava solicitada ou sem críticos;
- `1`: erro de execução;
- `2`: auditoria concluída, mas existem bloqueios críticos e `--fail-on-critical` foi usado.

## Evidências coletadas

### Implantação

- `HEAD` do checkout;
- `origin/main` local;
- branch;
- alterações não commitadas;
- comparação com o SHA informado como implantado.

### Banco

- caminho, tamanho e data de modificação;
- confirmação de `query_only`;
- `integrity_check`;
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

O relatório não presume que “valor positivo = histórico”. Ele apenas registra os dados existentes para a classificação posterior.

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

## Critérios para encerrar a Fase 0

- [ ] SHA realmente implantado registrado para backend e frontend;
- [ ] snapshot consistente criado e validado;
- [ ] auditor executado contra o banco vivo;
- [ ] relatório e digest preservados;
- [ ] todos os críticos classificados como dado real, defeito de código ou falso positivo;
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
