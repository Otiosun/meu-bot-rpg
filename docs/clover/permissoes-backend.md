# Contrato De Permissoes Do Backend

Este contrato descreve o modelo atual de acesso do Clover RPG. Ele deve ser
mantido em sincronia com:

- `helpers/groupAccess.js`
- `helpers/clover/accessControlService.js`
- `helpers/clover/accessIntegrationService.js`
- `helpers/clover/accessRoleAssignmentService.js`
- `comandos/cargo.js`

## Regra Central

O projeto possui dois niveis de identidade administrativa:

1. Owner
   - Nao e cargo de banco.
   - E reconhecido por `helpers/groupAccess.js`.
   - Usa `config/owner-access.json` e/ou lista interna de numeros de owner.
   - Tem acesso absoluto.

2. Cargos versionados
   - Vivem em `clover_access_roles`.
   - Sao auditados em `clover_access_role_events`.
   - Nunca devem incluir `owner`.

## Cargos Atuais

### `admin`

- Escopo: global.
- Permissoes: `*`.
- Uso: administracao total do RPG, Central ADM e sistemas operacionais.
- Deve ser concedido com cuidado; e o equivalente pratico de permissao total,
  mas nao substitui a identidade Owner.

### `narrator`

- Escopo: global.
- Permissoes:
  - `character.read.profile`
  - `character.read.progress`
  - `character.read.capacity`
  - `character.read.grimoire`
  - `squad.read.state`
  - `squad.read.members`
  - `squad.read.resources`
  - `raid.create`
  - `raid.read.all`
  - `raid.manage`

### `evaluator`

- Escopo: global.
- Permissoes base:
  - `character.read.profile`
  - `character.read.progress`
  - `character.read.capacity`
  - `character.read.grimoire`
  - `evaluation.apply`
  - `raid.reward.review`
- Permissoes integradas adicionais:
  - `character.read.capacity.technical`
  - `character.read.grimoire.technical`

### `captain`

- Escopo: esquadrao.
- Permissoes base:
  - `character.read.profile`
  - `character.read.progress`
  - `character.read.capacity`
  - `character.read.grimoire`
  - `squad.read.state`
  - `squad.read.members`
  - `squad.read.resources`
  - `squad.manage.members`
  - `raid.create`
  - `raid.manage`
- Permissoes integradas adicionais:
  - `squad.manage.upgrades`

### `vice_captain`

- Escopo: esquadrao.
- Permissoes base:
  - `character.read.profile`
  - `character.read.progress`
  - `character.read.capacity`
  - `character.read.grimoire`
  - `squad.read.state`
  - `squad.read.members`
  - `squad.read.resources`
- Permissoes integradas adicionais:
  - `squad.manage.upgrades`
- Nao gerencia membros no contrato atual.

## Camadas De Checagem

### `accessControlService`

Define chaves de cargo, permissoes base, schema, auditoria e contexto bruto.
Use quando um service precisa saber se um ator possui uma permissao simples.

### `accessIntegrationService`

Define nomes canonicos de permissoes usadas por comando/site, permissoes
integradas adicionais, acesso a personagem alvo e acesso a esquadrao.
Use em comandos e endpoints voltados a jogador/site.

### `accessRoleAssignmentService`

Define atribuicao/revogacao de cargos e sincronizacao de lideranca de esquadrao.
Use para alterar cargos. Nao escreva diretamente em `clover_access_roles`
exceto em instalador/migracao muito especifica.

## Como Criar Permissao Nova

1. Defina o nome em `ACCESS_PERMISSIONS`, se for usado por comando/site.
2. Adicione a permissao ao cargo correto em `ROLE_DEFINITIONS` ou
   `EXTRA_ROLE_PERMISSIONS`.
3. Atualize este documento.
4. Atualize `scripts/check-access-permissions-contract.js`.
5. Adicione teste de autorizacao do fluxo que usa a permissao.

## Times De Performance

Quando Times de Performance for versionado, a permissao deve seguir este
modelo:

- comandos publicos: sem cargo, quando forem apenas leitura/inscricao;
- comandos de monitoria: permissao dedicada ou cargo existente definido em PR;
- gestao total: Owner e `admin`;
- se houver cargo novo, ele deve entrar em `ACCESS_ROLE_KEYS`, schema,
  contrato, check e testes.

Nao usar ADM de grupo como criterio principal para avaliar ou gerir Times.
