# Site Clover Multicolor - API do Bot

## Ideia

O bot continua sendo a fonte oficial das regras, custos, requisitos, PH, PB, inventario e compras.
O site so mostra uma interface melhor e chama a API do bot para ler ou aplicar mudancas.

Fluxo de login:

1. Player chama o bot no PV com `.#site`.
2. Bot gera um codigo de 6 digitos com validade de 15 minutos.
3. Site pede numero + codigo.
4. Site chama `POST /auth/login`.
5. API devolve um token Bearer.
6. Site usa esse token para mostrar e alterar apenas o personagem daquele player.

## Variaveis do bot

```env
CLOVER_SITE_API_ENABLED=1
CLOVER_SITE_API_HOST=0.0.0.0
CLOVER_SITE_API_PORT=8787
CLOVER_SITE_API_ORIGIN=https://black-clover-multicolor.lovable.app
CLOVER_SITE_PUBLIC_URL=https://black-clover-multicolor.lovable.app/
```

Depois de alterar env no PM2:

```powershell
pm2 restart clover-rpg --update-env
```

Observacao: Lovable precisa chamar uma URL HTTPS publica. Se a API ficar local, use um tunel/reverse proxy apontando para a porta `8787`.

## Endpoints

Base URL exemplo:

```txt
https://sua-api-publica.example.com
```

Base URL atual via ngrok local compartilhado:

```txt
https://underuse-clamshell-crazily.ngrok-free.dev/clover-api
```

Enquanto usar `ngrok-free.dev`, as chamadas do site devem enviar também:

```txt
ngrok-skip-browser-warning: true
```

### `POST /auth/login`

Body:

```json
{
  "phone": "5511999999999",
  "code": "123456"
}
```

Resposta:

```json
{
  "ok": true,
  "token": "clv_...",
  "expiresAt": "2026-07-18T00:00:00.000Z",
  "player": {}
}
```

### Auth

Todos os endpoints abaixo usam:

```txt
Authorization: Bearer clv_...
```

### `GET /me`

Retorna o personagem logado e fase atual.

### `GET /character`

Retorna o pacote principal para a tela do player:

- identidade
- status de ficha/aparencia/historia/jogo
- mana, reserva e bonus
- atributos/PB
- PH
- capacidade tecnica
- carteira, estrelas, patente, esquadrao
- inventario

### `GET /attributes`

Retorna atributos atuais e uso de PB.

### `PUT /attributes`

Confirma direto a distribuicao final de atributos, usando as mesmas regras do bot.

Body:

```json
{
  "values": {
    "forca": 2,
    "velocidade": 2,
    "agilidade": 2,
    "resistencia": 2,
    "poder_magico": 2
  }
}
```

### `GET /inventory`

Retorna carteira, estrelas, patente, esquadrao e itens.

### `GET /ph`

Retorna PH atual e historico recente.

### `GET /trees`

Retorna as definicoes das arvores em JSON:

- mana
- fisico
- suporte
- criacao
- reforco

### `GET /trees/:treeId`

Retorna estado calculado da arvore do player:

- nos comprados
- nos disponiveis
- requisitos faltando
- custo base
- custo com desconto
- PH disponivel
- progresso por rota

### `POST /trees/:treeId/purchase`

Compra um no direto pelo site, sem aviso no WhatsApp, usando as mesmas travas do bot.
O site deve mostrar uma confirmacao visual antes de chamar esse endpoint.

Body:

```json
{
  "nodeId": "sentir_mana_i"
}
```

ou

```json
{
  "nodeAlias": "Sentir Mana I"
}
```

Se o no exigir aprovacao narrativa, a API bloqueia.
Se faltar PH ou requisito, a API bloqueia.

## Prompt para Lovable

Crie um app web para o RPG Black Clover Multicolor conectado a uma API externa do bot.

Objetivo: o player loga com numero + codigo temporario do bot e consegue ver/gerenciar o proprio personagem.

Use uma variavel `VITE_CLOVER_API_URL` para a base da API. O login chama `POST /auth/login` com `{ phone, code }`. Guarde o token Bearer em storage local seguro o bastante para MVP e envie `Authorization: Bearer <token>` nos endpoints privados.

Telas:

1. Login compacto com numero, codigo, botao entrar e link/aviso: "pegue o codigo no PV do bot com .#site".
2. Dashboard do personagem usando `GET /character`: nome, reino, raca, classe, grimorio, magia, status, mana total, reserva, PB, PH, Yulls, estrelas, patente, esquadrao e inventario resumido.
3. Atributos usando `GET /attributes` e `PUT /attributes`: controles numericos para forca, velocidade, agilidade, resistencia e poder magico. Mostrar PB total/usado/livre. Botao confirmar so habilita quando a API aceitar a distribuicao.
4. Arvores usando `GET /trees` e `GET /trees/:treeId`: interface visual propria com filtros por arvore/rota/status. Cada no mostra nome, custo, status, requisitos e efeito curto. Botao comprar aparece apenas em no disponivel. Antes de comprar, abrir modal de confirmacao e chamar `POST /trees/:treeId/purchase`.
5. Inventario usando `GET /inventory`: Yulls, estrelas, patente, esquadrao, itens com nome, quantidade e descricao.
6. PH usando `GET /ph`: saldo e historico recente.

Regras importantes:

- O site nunca calcula compra sozinho; ele so exibe dados recebidos e chama a API.
- Se a API retornar erro, mostre a mensagem de forma clara e nao altere estado local como se tivesse comprado.
- Compra de no pelo site nao precisa avisar no WhatsApp.
- O player so ve o proprio personagem pelo token.
- Endpoints de ADM ficam fora desse MVP.
- A interface da arvore pode ser feita livremente, mas custos, requisitos e status devem vir da API.
