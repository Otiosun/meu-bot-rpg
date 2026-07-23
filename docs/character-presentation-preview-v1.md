# Prévia protegida da ficha — V1

## Objetivo

Validar o contrato `character-presentation.v1` com dados reais antes de substituir qualquer tela do jogador.

A prévia é somente leitura e não participa do fluxo normal do site.

## Endpoint

```http
GET /character/presentation-preview
Authorization: Bearer <sessão do site>
```

A rota aceita também `OPTIONS` para preflight. Outros métodos retornam `405 method_not_allowed`.

## Segurança

- exige sessão válida do site;
- resolve exclusivamente o personagem autenticado;
- não aceita `playerId` por parâmetro;
- força `audience: player`;
- força `includeTechnical: false`;
- não grava no banco;
- não executa fila econômica;
- não altera `/character`;
- não é consumida por nenhuma tela atual;
- usa `Cache-Control: private, no-store, max-age=0`;
- falhas internas são convertidas em mensagem genérica.

## Resposta

```json
{
  "ok": true,
  "preview": true,
  "readOnly": true,
  "presentation": {
    "schemaVersion": "character-presentation.v1",
    "audience": "player"
  },
  "comparison": {
    "version": "character-presentation-comparison.v1",
    "readOnly": true,
    "legacyEndpoint": "/character",
    "previewEndpoint": "/character/presentation-preview",
    "aligned": {
      "identityName": true,
      "familyName": true,
      "stage": true,
      "manaTotal": true,
      "fixedTraits": true
    },
    "sourceRisks": {
      "structuredFamilyObject": true,
      "technicalCapacityEmbedded": true,
      "mixedSystemNotices": true
    },
    "counts": {}
  }
}
```

## Comparação

A comparação não devolve valores brutos divergentes. Ela expõe somente:

- alinhamento booleano de campos essenciais;
- riscos conhecidos na resposta antiga;
- contagens do contrato apresentado.

Assim, nomes internos, IDs, flags, pesos, caminhos SQLite e códigos de operação não entram no diagnóstico.

## Critério para o próximo marco

A página de Perfil só poderá consumir o contrato novo quando:

1. a suíte de apresentação estiver integralmente aprovada;
2. a prévia funcionar sobre uma cópia do banco real;
3. Família, traços, ganchos, estágio e mana estiverem alinhados;
4. não houver campos técnicos na resposta do jogador;
5. `/character` e as telas atuais permanecerem sem regressão.
