# Contrato Canônico de Apresentação da Ficha — V1

## Estado

- **Schema:** `character-presentation.v1`
- **Fase:** Marco 0 + Marco 1
- **Integração com rotas:** nenhuma
- **Alteração de banco:** nenhuma
- **Alteração de produção:** nenhuma

Este contrato existe para impedir que cada página interprete sozinha os objetos técnicos do Clover.

## Objetivo

Separar formalmente:

1. os dados técnicos usados pelo bot;
2. a apresentação pedagógica do jogador;
3. a leitura operacional do narrador;
4. a auditoria aprofundada do ADM.

Os serviços atuais continuam sendo a fonte de verdade. O adaptador apenas seleciona, nomeia, organiza e filtra o que cada público recebe.

## Fontes aceitas

O adaptador recebe quatro blocos:

- `player`: cadastro do personagem;
- `bonus`: resultado de `getCharacterBonusSummary`;
- `capacity`: resultado de `getPlayerTechnicalCapacity`;
- `traits`: resultado de `getAdminPlayerTraitOverview`.

O contrato não consulta rotas HTTP e não substitui serviços de cálculo.

## Estrutura pública

```js
{
  schemaVersion,
  audience,
  generatedAt,
  identity,
  narrative,
  progression,
  capabilities,
  modifiers
}
```

### `identity`

Contém somente identidade apresentável:

- nome;
- imagem;
- reino;
- raça;
- classe social;
- família estruturada;
- magia;
- grimório;
- esquadrão;
- patente.

Objetos como `family` nunca são convertidos com `String(object)`.

### `narrative`

Contém:

- traços fixos preenchidos;
- traços extras;
- anomalias extras;
- ganchos narrativos;
- itens narrativos.

Cada traço pode apresentar:

- nome;
- descrição;
- efeito;
- restrições;
- raridade;
- imagem;
- origem de apresentação.

Descrições ausentes permanecem `null`. O adaptador não inventa regras.

### `progression`

Contém:

- estágio;
- PH disponível e acumulado;
- mana total e reserva;
- atributos reconhecidos;
- valores e rótulos do Hexágono.

Campos internos como `stage_key`, `updated_by` e IDs não entram aqui.

### `capabilities`

Contém:

- síntese geral;
- capacidades práticas;
- limites atuais;
- alertas de supervisão;
- resumo das árvores.

As propriedades internas `flags`, `weights`, objetos de nós e chaves de implementação permanecem fora da apresentação comum.

### `modifiers`

Separa:

- automáticos;
- condicionais;
- penalidades;
- descontos;
- avisos do sistema.

Descontos de `0%` são descartados. Explicações gerais do sistema não são apresentadas como bônus pessoais.

## Públicos

### Jogador

Recebe apenas os blocos públicos.

### Narrador

Recebe o mesmo contrato seguro, preparado para futura ordenação operacional. Não recebe objetos técnicos crus.

### ADM

Recebe também `audit`, com diagnóstico de disponibilidade das fontes e lista de traços sem descrição.

O bloco `technical` só é incluído quando:

```js
{
  audience: 'admin',
  includeTechnical: true
}
```

## Regras obrigatórias

1. Nunca produzir `[object Object]`.
2. Nunca mostrar `-`, `—`, `null`, `undefined`, `nenhum` ou `n/a` como registros válidos.
3. Nunca inventar descrição, efeito ou restrição.
4. Não expor IDs, códigos de operação ou metadados internos ao jogador e ao narrador.
5. Separar avisos sistêmicos de efeitos pessoais.
6. Remover descontos de `0%`.
7. Deduplicar nomes normalizados sem destruir a redação original.
8. Reparar mojibake apenas quando a conversão for inequívoca.
9. Manter o contrato serializável em JSON.
10. Não alterar o banco durante a construção do objeto de apresentação.

## Fixtures

As fixtures são sintéticas e anonimizadas:

- `legacy-fragmented.json`: representa cadastro legado, traço extra em fonte paralela, bônus fragmentados e campos técnicos internos;
- `catalog-rich.json`: representa ficha já estruturada, com família em objeto, traços completos, anomalia extra, bônus, penalidade, desconto e metadados que não podem vazar.

Nenhum telefone, JID, nome real de jogador ou identificador operacional de produção foi copiado.

## Critérios deste marco

- contrato puro testável sem banco;
- wrapper de leitura disponível, mas não conectado a endpoint;
- fixtures anonimizadas;
- regressão contra `[object Object]`;
- regressão contra vazamento de chaves internas;
- separação de modificadores;
- área técnica restrita a ADM explícito.

## Próximo marco

Depois da aprovação deste contrato:

1. expor endpoint de prévia protegido;
2. comparar a resposta com as rotas atuais;
3. migrar primeiro a página Perfil;
4. migrar Capacidades;
5. criar apresentação específica do snapshot de raid;
6. integrar a ficha administrativa geral.
