# Guia de revisao tecnica do backend Clover

Este guia e o ponto de entrada para uma revisao externa do backend. Ele nao
substitui os contratos de produto, mas mostra onde olhar, quais comandos rodar
e quais limites operacionais respeitar.

## Leitura inicial

1. `docs/clover/mapa-tecnico-backend.md`
2. `docs/clover/permissoes-backend.md`
3. `docs/clover/runbook-operacional-site.md`
4. `docs/clover/runbook-publicacao-final.md`

Depois disso, escolha o dominio pela mudanca em analise.

## Dominio por area

Economia e posses:
- `helpers/clover/possessionsService.js`
- `helpers/clover/boxPityService.js`
- `helpers/clover/economy*.js`
- `tests/possessionsTitlesBoxesCore.test.js`
- `tests/boxPity*.test.js`

Personagem, ficha e identidade:
- `helpers/clover/player*.js`
- `helpers/clover/profileAccessPreservationService.js`
- `helpers/clover/playerIdentity*.js`
- `tests/player*.test.js`
- `tests/*Identity*.test.js`

Feiticos, capacidade e grimoire:
- `helpers/clover/spell*.js`
- `helpers/clover/capacity*.js`
- `tests/spell*.test.js`
- `scripts/auditSpellCapacity.js`
- `scripts/check-spellbook-presentation.js`

Esquadroes, capitaes e estrelas:
- `helpers/clover/squad*.js`
- `helpers/clover/captain*.js`
- `helpers/clover/raid*.js`
- `tests/captainsSeasonStars.test.js`
- `tests/captainPersonaRegistration.test.js`

Mundos dos Sonhos:
- `helpers/clover/dreamWorlds*.js`
- `scripts/installDreamWorldsV1.js`
- `scripts/validateDreamWorldsV1.js`
- `scripts/auditDreamWorldsV1.js`
- `tests/dreamWorlds*.test.js`

Central ADM e API do site:
- `helpers/clover/admin*.js`
- `helpers/clover/site*.js`
- `server.js`
- `tests/cloverAdmin*.test.js`
- `tests/site*.test.js`

Permissoes:
- `helpers/clover/accessControlService.js`
- `helpers/clover/accessIntegrationService.js`
- `helpers/clover/accessRoleAssignmentService.js`
- `helpers/groupAccess.js`
- `scripts/check-access-permissions-contract.js`

## Comandos por tipo de revisao

Revisao curta de permissoes:

```powershell
npm run check:access-permissions
node scripts/check-access-role-integrations.js
npm run test:admin-team
```

Revisao de Mundos dos Sonhos:

```powershell
npm run test:dream-worlds
npm run test:database-lifecycle
```

Revisao de capitaes, esquadroes e estrelas:

```powershell
npm run test:captains-season-stars
npm run test:captain-personas
```

Revisao de site/API:

```powershell
npm run test:site-auth
npm run test:site-stack
npm run diagnose:runtime
```

Revisao ampla local:

```powershell
npm test
git diff --check
```

## Cuidados obrigatorios

- Nunca usar `banco.sqlite` vivo em testes destrutivos.
- Nunca rodar script com `--apply` sem backup e autorizacao explicita.
- Nunca iniciar outro bot se o PM2 ja tiver uma instancia viva.
- Nunca versionar banco, backup, token, QR, sessao WhatsApp, `.env` ou tunnel.
- Nunca transformar `owner` em cargo de banco; owner vem de `helpers/groupAccess.js`.
- Nunca usar `git reset`, `git clean`, `prune` ou force push para limpar trabalho local
  sem uma autorizacao especifica.

## Padrao esperado para mudancas

1. Ler o service e os testes existentes do dominio.
2. Corrigir no menor ponto confiavel.
3. Adicionar teste de regressao no mesmo nivel da regra.
4. Rodar a suite especifica do dominio.
5. Rodar `git diff --check`.
6. Documentar comandos, resultado e riscos no PR ou relatorio.

## Sinais de alerta

- Logica que consulta jogador por nome antes de normalizar telefone/JID.
- Mutacao de inventario, Yuls, PA, PH ou PR sem idempotencia.
- Fluxo administrativo sem permissao escopada.
- Divergencia entre tabelas novas e campos legados de personagem.
- Script operacional que escreve antes de criar backup.
- CHECK novo sem trigger para proteger banco legado.
- Endpoint publico que retorna dados privados de avaliacao, identidade ou cargo.

## Estado de Times de Performance

O sistema de Times de Performance deve entrar por branch e PR propria. A `main`
atual pode documentar o modelo, mas comandos e services de Times nao devem ser
misturados a PRs de capitaes, raides, Mundos dos Sonhos ou manutencao de cargos.
