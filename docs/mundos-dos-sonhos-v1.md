# Mundos dos Sonhos — contrato V1

Este arquivo é a fonte de verdade entre o backend `meu-bot-rpg` e o frontend `Clover-multicolor`.

## 1. Princípios congelados

- Aquisição nunca é automática na V1.
- Enviar solicitação não desconta Yuls.
- Aprovação por Yuls desconta e cria a incursão na mesma transação.
- Repetir uma aprovação não pode descontar novamente.
- Confirmação manual não altera dificuldade, avaliação ou recompensa.
- Não existe Mundo dos Sonhos solo: `minPlayers >= 2`.
- Distribuição de vagas usa números inteiros explícitos.
- Uma Fenda reservada não aceita uma segunda aprovação.
- Toda ação administrativa relevante gera auditoria.
- Cancelar uma incursão não produz estorno automático.
- A versão registrada de um Fragmento prevalece sobre a obra de origem.

## 2. Estados

### Fenda

`draft | announced | available | reserved | forming_group | running | completed | cancelled`

### Solicitação

`submitted | under_review | awaiting_confirmation | approved | rejected | cancelled`

### Incursão

`forming_group | ready | running | paused | completed | failed | cancelled`

### Vaga

`open | invited | confirmed | declined | withdrawn | replaced`

### Fragmento

`draft | review | active | sealed | changed | revoked`

## 3. Tipos

### Manifestação

- `self`: o mago preserva a identidade.
- `assumed_identity`: o mago assume outra vida.
- `mixed`: regras específicas combinam os dois modelos.

### Responsável pela aquisição

- `player`
- `squad`

### Forma de aquisição

- `yulls`
- `manual`

## 4. Contrato HTTP

As rotas são expostas sob `/clover-api` no bot e consumidas pelo proxy `/api/clover` no site.

### Público

- `GET /dream-worlds`
- `GET /dream-worlds/:slug`
- `GET /dream-fragments`
- `GET /dream-fragments/:slug`

### Personagem autenticado

- `GET /dream-worlds/me`
- `POST /dream-worlds/:id/requests`
- `POST /dream-worlds/invitations/:id/accept`
- `POST /dream-worlds/invitations/:id/decline`

### Administração

- criar, editar, anunciar e abrir Fendas;
- aprovar e recusar solicitações;
- listar e operar incursões;
- atribuir, remover e substituir vagas;
- iniciar, avançar, pausar, retomar, concluir, falhar e cancelar incursões;
- criar, atualizar e conceder Fragmentos;
- consultar auditoria e versões.

O detalhamento de caminhos e payloads permanece em `docs/mundos-dos-sonhos-http-contract.md`.

## 5. Solicitação

Exemplo:

```json
{
  "buyerType": "player",
  "buyerId": null,
  "paymentMethod": "yulls",
  "playerNote": "Observação opcional",
  "idempotencyKey": "site-dream-request:UUID"
}
```

Enviar a solicitação apenas verifica o saldo disponível. O débito acontece somente na aprovação.

## 6. Aprovação por Yuls

Operação atômica obrigatória:

1. bloquear escrita concorrente;
2. reler solicitação e Fenda;
3. confirmar saldo disponível;
4. registrar débito idempotente no ledger;
5. criar incursão;
6. criar todas as vagas;
7. confirmar o responsável em uma vaga;
8. marcar solicitação como aprovada;
9. marcar Fenda como reservada;
10. registrar auditoria;
11. confirmar transação.

Qualquer falha executa rollback completo.

## 7. Concorrência

A suíte V1 contém disputas com duas conexões SQLite ao mesmo arquivo para provar:

- uma única aprovação e um único débito;
- uma única ocupação por vaga;
- uma única decisão por convite.

As operações críticas usam `BEGIN IMMEDIATE`, restrições de unicidade e chaves idempotentes.

## 8. Cancelamento

- solicitação aprovada permanece registrada como `approved`;
- incursão e Fenda podem ficar `cancelled`;
- Yuls não retornam automaticamente;
- o motivo é preservado na incursão e na auditoria;
- qualquer devolução futura exige transação inversa separada e auditada.

A política completa está em `docs/mundos-dos-sonhos-policies-v1.md`.

## 9. Trabalho implementado

- schema isolado e criação idempotente das tabelas;
- cadastro, catálogo e detalhe público de Fendas;
- solicitações por personagem ou esquadrão;
- Yuls e confirmação manual;
- aprovação atômica e idempotente;
- incursões, vagas, convites, substituições e progressão;
- Fragmentos, concessão, versões e Arquivo público;
- dashboard do personagem;
- rotas públicas, autenticadas e administrativas;
- permissões da Central ADM;
- auditoria readonly;
- testes de serviço, HTTP, registro, política, concorrência e cancelamento;
- seed demonstrativo protegido para cópia de preview.

## 10. Validação segura

### Somente testes

```bash
npm run test:dream-worlds
```

### Testes + cópia + auditoria

```bash
npm run validate:dream-worlds -- --db=./caminho/do/banco.sqlite
```

### Testes + cópia + conteúdo demonstrativo + auditoria

```bash
npm run validate:dream-worlds -- --db=./caminho/do/banco.sqlite --seed-preview
```

O script cria uma cópia via `VACUUM INTO`. O banco informado nunca é usado como destino de escrita.

O seed avulso exige:

```bash
npm run seed:dream-worlds-preview -- --db=./backups/copia-preview.sqlite --allow-preview-write
```

Ele recusa caminhos que não estejam claramente identificados como backup, preview, staging, sandbox, teste ou cópia.

## 11. Gate antes do merge

- atualizar a branch contra o `main` em clone Git completo;
- executar `npm run test:dream-worlds` num runner funcional;
- executar auditoria apenas em cópia do banco;
- realizar teste ponta a ponta com sessão real e API local/túnel de preview;
- confirmar regressões de economia, autenticação, site stack e lifecycle do banco;
- manter PR em rascunho enquanto qualquer item acima estiver pendente.
