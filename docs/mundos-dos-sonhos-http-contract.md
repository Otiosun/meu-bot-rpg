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
