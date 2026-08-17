# Clover RPG — Baseline canônico da FASE 0

Data: 17/08/2026

## Gate

**FASE 0: PASS.** O estado de produção foi identificado e preservado com precisão suficiente para iniciar a FASE 1 sem substituir o runtime às cegas.

## Identidade de versões

- Backend GitHub main: `9533bcebaae202cb15da10592c2eded15a98164a`
- Backend Windows live HEAD: `923d05b66883e39510c68e14a109b005950d6cfc`
- Estado do live: detached HEAD
- Distância: main 56 commits à frente, 0 atrás
- Frontend/Vercel permanecem no baseline já auditado da FASE 0.

## Código live versus main

### 38 arquivos tracked modificados no Windows

- **25** já são equivalentes ao `main`; são evolução oficial aplicada/copied ao runtime antigo.
- **13** permanecem como hotfix real do runtime e precisam ser portados intencionalmente para cima do `main`.

Hotfixes reais:
- `helpers/chatReply.js`
- `helpers/clover/appearanceManager.js`
- `helpers/clover/playerPhase.js`
- `helpers/clover/privateDeliveryWorker.js`
- `helpers/clover/privateMessagePolicy.js`
- `helpers/clover/privateMessagePolicyRuntime.js`
- `helpers/clover/siteAuthService.js`
- `index.js`
- `tests/chatReplyPolicyHookContract.test.js`
- `tests/privateDeliveryWorkerContract.test.js`
- `tests/privateMessagePolicyContract.test.js`
- `tests/privateMessagePolicyRuntimeContract.test.js`
- `tests/privateMessagePolicySourcesContract.test.js`

### 52 arquivos untracked

- **34** são arquivos adicionados posteriormente no GitHub e presentes fisicamente no live. O conteúdo foi validado contra o `main`; quatro aparentes diferenças eram exclusivamente CRLF/LF.
- **18** são ferramentas/diagnósticos live-only. Nenhum é importado pelo runtime; o pacote `urgentOperationalRepair*` é autocontido entre serviço, script e testes. Eles devem ser preservados como evidência histórica/quarentena, não promovidos automaticamente a código de produção.

Ferramentas live-only:
- `.video-feedback-event-rewards-20260807-124251.cjs`
- `check-community-exit-150.cjs`
- `check-community-exit-duplicates.cjs`
- `diagnose-community-exit-state.cjs`
- `diagnostico-community-exit.txt`
- `diagnostico-economy-queue.txt`
- `diagnostico-salarios-final.txt`
- `diagnostico-varreduras-economia.txt`
- `patch-community-exit-fix-v2.cjs`
- `patch-community-exit-single-pending-v1.cjs`
- `patch-economy-init-cache.cjs`
- `patch-economy-performance.cjs`
- `scripts/reconcileHistoricalRewards20260810.cjs`
- `scripts/repairUrgentOperationalDrift20260806.cjs`
- `scripts/repairUrgentOperationalDrift20260806.cjs.before-postvalidation-fix`
- `helpers/clover/urgentOperationalRepairService.js`
- `tests/urgentOperationalRepairService.test.js`
- `tests/urgentOperationalRepairSqlite.test.js`

### Código existente no main e ausente do live

Há **26** arquivos oficiais novos que não estão fisicamente no runtime, incluindo a integração mais recente do Admin Inbox de Spell Reviews e seus testes. Isso comprova que produção não pode ser descrita simplesmente pelo SHA do HEAD nem pelo SHA do main.

## Auth hardening live

O live contém proteções adicionais que não podem ser perdidas:

1. máximo padrão de 5 sessões ativas por jogador;
2. criação de nova sessão revoga apenas sessões excedentes;
3. código de login não é criado para jogador não liberado;
4. login revalida elegibilidade antes de consumir o código;
5. sessão existente é revogada quando o jogador deixa de ser elegível;
6. identidade/canonicalização continua integrada ao Identity Graph oficial.

Validação isolada em SQLite real (`node:sqlite`): **4/4 cenários passaram**.

## Política de mensagens privadas / lifecycle

Hotfix live forma um pacote coerente:

- distingue `.#site` como `site_command_reply`;
- allowlist estrita de fontes privadas;
- hard-block de fontes não permitidas mesmo quando a política está `off/observe`;
- `appearance_approved` separado de rejeição/resultado genérico;
- jogador `archived/arquivado` falha fechado antes de bypass normal;
- `index.js` propaga `lifecycleStatus` e `gameStatus` para o gate.

Validação: **41/41 testes do pacote de política privada passaram** e smoke test do lifecycle passou.

## Runtime / banco

- Node: `v24.14.1`
- API local: porta 8787, HTTP 200
- PM2: daemon vivo; dois ProcessContainerFork observados
- SQLite core: `3.51.2`
- journal mode: `WAL`
- banco vivo: `PRAGMA quick_check = ok`
- snapshot: `node:sqlite.backup`
- snapshot: `PRAGMA integrity_check = ok`
- snapshot SHA-256: `45952a05fd9aee1518bb6e575029681f405fd55e4df9981fadbcb78c3a0f1ed6`

O SQLite 3.51.2/WAL entra como risco explícito da FASE 1/2. Não é evidência de corrupção atual e não autoriza upgrade impulsivo.

## Validação do snapshot de código recebido

- ZIP do live foi sanitizado localmente sem ler `auth_info*`/credenciais.
- 738 arquivos JS/CJS/MJS passaram `node --check`: **0 erros**.
- Diretórios sensíveis/backup que escaparam do exportador original foram excluídos do laboratório.

## Regra para FASE 1

Nunca fazer `git pull/reset/checkout main` sobre o live atual. A convergência deve ocorrer fora de produção:

1. partir do `main`;
2. portar apenas os hotfixes reais;
3. preservar o comportamento validado;
4. executar testes/contratos;
5. produzir release reproduzível;
6. só então planejar aplicação ao Windows com rollback.
