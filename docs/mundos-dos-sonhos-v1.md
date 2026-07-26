# Mundos dos Sonhos — contrato V1

Este arquivo é a fonte de verdade entre o backend `meu-bot-rpg` e o frontend `Clover-multicolor`.

## Princípios congelados

- Compra nunca é automática na V1.
- Enviar solicitação não desconta Yuls.
- Aprovação por Yuls desconta e cria a incursão na mesma transação.
- Repetir uma aprovação não pode descontar novamente.
- Pagamento manual não altera dificuldade, avaliação ou recompensa.
- Não existe Mundo dos Sonhos solo: `minPlayers >= 2`.
- Distribuição de vagas usa números inteiros explícitos, nunca porcentagens soltas.
- Uma Fenda reservada não aceita uma segunda aprovação.
- Toda aprovação ou recusa gera auditoria.

## Estados

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

## Tipos

### Mundo dos Sonhos

- `self`: o mago preserva a identidade.
- `assumed_identity`: o mago assume outra vida.
- `mixed`: regras específicas combinam os dois modelos.

### Comprador

- `player`
- `squad`

### Pagamento

- `yulls`
- `manual`

## Contrato HTTP previsto

As rotas serão expostas sob `/clover-api` no bot e consumidas pelo proxy `/api/clover` no site.

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

- `POST /admin/dream-worlds`
- `PATCH /admin/dream-worlds/:id`
- `POST /admin/dream-worlds/:id/announce`
- `POST /admin/dream-worlds/:id/open`
- `POST /admin/dream-requests/:id/approve`
- `POST /admin/dream-requests/:id/reject`
- `POST /admin/dream-runs/:id/start`
- `POST /admin/dream-runs/:id/complete`
- `POST /admin/dream-fragments`
- `POST /admin/dream-fragments/:id/grant`

## Solicitação

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

Resposta:

```json
{
  "ok": true,
  "duplicate": false,
  "request": {
    "id": 12,
    "key": "MSR-2026-XXXXXXXXXX",
    "worldId": 3,
    "buyerType": "player",
    "buyerId": "player@lid",
    "paymentMethod": "yulls",
    "status": "submitted"
  }
}
```

## Aprovação por Yuls

Operação atômica obrigatória:

1. bloquear escrita concorrente;
2. reler solicitação e Fenda;
3. confirmar saldo disponível;
4. registrar débito no ledger com idempotência;
5. criar incursão;
6. criar todas as vagas;
7. confirmar o comprador em uma vaga;
8. marcar solicitação como aprovada;
9. marcar Fenda como reservada;
10. registrar auditoria;
11. confirmar transação.

Qualquer falha executa rollback completo.

## Trabalho implementado nesta branch

- schema isolado criado por `ensureDreamWorldsSchema`;
- cadastro de Fenda;
- catálogo público no domínio;
- solicitação por personagem ou esquadrão;
- validação de saldo sem desconto antecipado;
- aprovação atômica por Yuls;
- criação da incursão e das vagas;
- recusa sem movimentação financeira;
- painel de dados do personagem;
- testes focados em idempotência, saldo e vagas.

## Ainda pendente

- registrar as rotas HTTP;
- integrar permissões administrativas reais;
- convites e substituições;
- CRUD de Fragmentos;
- integração com o frontend;
- migração explícita no boot;
- testes HTTP e de concorrência.
