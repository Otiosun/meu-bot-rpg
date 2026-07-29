# Matriz de validacao do backend

Use esta matriz para escolher a menor suite confiavel para cada mudanca. Quando
a alteracao cruzar dominios, rode todas as linhas afetadas.

## Sempre

```powershell
git diff --check
node --check <arquivo-js-alterado>
```

Para mudancas em `package.json`:

```powershell
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('package.json OK')"
```

## Permissoes e cargos

Arquivos comuns:
- `helpers/groupAccess.js`
- `helpers/clover/accessControlService.js`
- `helpers/clover/accessIntegrationService.js`
- `helpers/clover/accessRoleAssignmentService.js`
- `comandos/cargo.js`

Comandos:

```powershell
npm run check:access-permissions
node scripts/check-access-role-integrations.js
npm run test:admin-team
```

Rode tambem `npm run test:site-auth` se a mudanca alterar acesso do site.

## Central ADM

Arquivos comuns:
- `helpers/clover/admin*.js`
- `helpers/clover/siteApiServerBase.js`
- `helpers/clover/siteApiServer.js`

Comandos:

```powershell
npm run test:admin-core
npm run test:site-auth
npm run test:site-stack
```

## Site/API local

Arquivos comuns:
- `server.js`
- `helpers/clover/site*.js`
- `scripts/startCloverSiteStack.js`
- `scripts/diagnoseCloverRuntime.js`

Comandos:

```powershell
npm run test:site-stack
npm run test:site-auth
npm run diagnose:runtime
```

`diagnose:runtime` consulta o ambiente atual; nao deve substituir testes de
service.

## Mundos dos Sonhos

Arquivos comuns:
- `helpers/clover/dreamWorlds*.js`
- `scripts/installDreamWorldsV1.js`
- `scripts/validateDreamWorldsV1.js`
- `scripts/auditDreamWorldsV1.js`

Comandos:

```powershell
npm run test:dream-worlds
npm run test:database-lifecycle
```

Para banco real, somente com autorizacao:

```powershell
npm run install:dream-worlds -- --db="CAMINHO" --allow-live-write
```

Esse script precisa criar backup antes da escrita e rodar auditoria depois.

## Raids, capitaes, esquadroes e estrelas

Arquivos comuns:
- `helpers/clover/raid*.js`
- `helpers/clover/squad*.js`
- `helpers/clover/captain*.js`
- `helpers/clover/accessIntegrationService.js`

Comandos:

```powershell
npm run test:captains-season-stars
npm run test:captain-personas
npm run test:raid-progress
```

Se alterar finalizacao/recompensas de Raid, incluir:

```powershell
npm run test:raid-finalization
```

## Economia, inventario, caixas e titulos

Arquivos comuns:
- `helpers/clover/possessionsService.js`
- `helpers/clover/boxPityService.js`
- `helpers/clover/economy*.js`
- `helpers/clover/*Yulls*.js`
- `helpers/clover/*Ph*.js`
- `helpers/clover/*Pr*.js`

Comandos:

```powershell
npm run test:possessions-v1
npm run test:box-pity
npm run test:economy-operations
```

Para alteracoes amplas em economia:

```powershell
npm run test:economy-foundation
npm run test:economy-operations
```

## Personagem, identidade e acesso

Arquivos comuns:
- `helpers/clover/player*.js`
- `helpers/clover/profileAccessPreservationService.js`
- `helpers/clover/playerIdentity*.js`
- `scripts/*Identity*.js`

Comandos:

```powershell
npm run test:player-access
npm run test:data-integrity
npm run test:site-auth
```

## Feiticos, capacidades e grimorio

Arquivos comuns:
- `helpers/clover/spell*.js`
- `helpers/clover/capacity*.js`
- `comandos/capacidade.js`
- `comandos/filaFeitico.js`

Comandos:

```powershell
npm run test:spell-flow
npm run test:spell-approval
npm run test:spell-queue-audit
npm run check:capacity-catalog
```

## CloverScript e operacoes administrativas

Arquivos comuns:
- `comandos/cloverScript.js`
- `helpers/clover/cloverScript*.js`

Comandos:

```powershell
npm run test:admin-core
npm run test:data-integrity
```

Se a mudanca afetar economia ou membros, rode tambem a suite especifica do
dominio afetado.

## Revisao ampla

Use quando a mudanca atravessar muitas fronteiras:

```powershell
npm test
git diff --check
```

Evite rodar suite global durante manutencao de runtime vivo se houver risco de
servico externo, bot ou banco real envolvido. Prefira copia isolada do banco.
