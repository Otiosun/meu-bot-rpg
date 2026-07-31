# Fase 0 — auditoria de identidades vazias

Esta auditoria classifica registros de `jogadores` cujo `id` é `NULL`, vazio ou composto apenas por espaços. Ela não remove, arquiva, corrige ou migra registros.

## Evidência que motivou o comando

A coleta privada da Fase 0 encontrou dez linhas homogêneas chamadas `Cacador`, sem personagem, com ficha incompleta e jogo bloqueado. O schema atual declara `id` como chave primária textual, mas permite `NULL`.

## Garantias

- abre somente o snapshot com `OPEN_READONLY`;
- confirma `PRAGMA query_only=ON`;
- valida o SHA exato do auditor antes de abrir o banco;
- mede SHA-256, tamanho e `mtime` antes e depois;
- recusa sobrescrever relatório existente;
- não executa `CREATE`, `INSERT`, `UPDATE`, `DELETE`, migração ou correção;
- relatório declara `write: false` e `queryOnlySafe: true`.

## O que é analisado

1. definição real de `jogadores.id`;
2. assinatura e desvios de cada identidade vazia;
3. conteúdo fora dos defaults do schema;
4. chaves estrangeiras declaradas apontando para `jogadores`;
5. colunas explicitamente nomeadas como `player_rowid` ou `jogador_rowid`;
6. referências externas ao nome exato `Cacador` em colunas de nome/personagem.

Referências genéricas com valor `NULL` não conseguem distinguir qual dos dez placeholders seria o alvo. Por isso, a auditoria não usa mera contagem de `NULL` como prova de vínculo individual.

## Execução

```bash
AUDITOR_SHA="$(git rev-parse HEAD)"

node scripts/auditBlankPlayerIdentities.js \
  --db=/caminho/privado/clover-phase0.snapshot.sqlite \
  --expected-auditor-sha="$AUDITOR_SHA" \
  --output=/caminho/privado/clover-phase0.blank-player-identities.json \
  --fail-on-unsafe
```

## Códigos

- `0`: execução técnica válida e nenhuma revisão obrigatória;
- `2`: execução válida, mas limpeza automática continua bloqueada;
- `1`: falha técnica, SHA incorreto ou alteração do snapshot.

## Critério de limpeza futura

Nenhum registro deve ser removido enquanto houver:

- campo substantivo fora dos defaults;
- assinatura diferente do placeholder conhecido;
- referência explícita por `rowid`;
- referência externa por nome não classificada;
- ausência de backup e plano de reconstrução do schema.

Mesmo com relatório limpo, a correção final deve ser reversível: backup, recibo por `rowid`, remoção em transação e reconstrução de `jogadores.id` com identidade não nula realmente aplicada.
