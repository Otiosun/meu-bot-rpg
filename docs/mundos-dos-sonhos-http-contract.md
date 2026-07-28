# Mundos dos Sonhos — contrato HTTP V1

## Rotas públicas

- `GET /dream-worlds`
  - filtro opcional: `?status=announced|available|reserved|forming_group|running|completed|cancelled`
- `GET /dream-worlds/:slug`

## Rotas autenticadas

- `GET /dream-worlds/me`
- `POST /dream-worlds/:id-or-slug/requests`

Corpo da solicitação:

```json
{
  "buyerType": "player",
  "buyerId": null,
  "paymentMethod": "yulls",
  "playerNote": "Observação opcional",
  "idempotencyKey": "site-dream-request:uuid"
}
```

O envio não desconta Yuls. O saldo é conferido novamente durante a aprovação.

## Rotas administrativas

- `GET /admin/dream-worlds` — exige `raid.view`
- `POST /admin/dream-worlds` — exige `raid.manage`
- `GET /admin/dream-worlds/requests` — exige `raid.view`
- `POST /admin/dream-worlds/requests/:id/approve` — exige `raid.manage` e `resource.adjust`
- `POST /admin/dream-worlds/requests/:id/reject` — exige `raid.manage`

A aprovação por Yuls é executada dentro da fila de mutações econômicas e da mesma transação que cria a incursão, gera vagas, reserva a Fenda e registra auditoria.

## Transicao administrativa de publicacao

- `POST /admin/dream-worlds/:id-or-slug/status` exige `raid.manage`.
- Corpo: `{ "status": "announced|available|draft|cancelled", "reason": "texto opcional" }`.
- O identificador aceita `id`, `slug` ou `world_key`.
- A resposta bem-sucedida retorna `200` com `{ ok, world, data }`.
- Transicoes permitidas: `draft -> announced`, `announced -> draft`, `announced -> available`, `available -> announced`, `draft -> cancelled`, `announced -> cancelled`, `available -> cancelled`.
- `announced` aparece no catalogo publico, mas continua recusando `POST /dream-worlds/:id-or-slug/requests` ate virar `available`.
- `announced -> draft` e bloqueado se existir solicitacao ativa ou incursao vinculada.
- `cancelled` exige `reason`, preserva historico e nao executa estorno automatico.
