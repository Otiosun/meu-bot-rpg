# Handoff para revisao externa

Este checklist e para alguem que vai revisar ou ajudar no backend Clover sem
conhecer o historico recente do projeto.

## Contexto rapido

- Repositorio backend: `Otiosun/meu-bot-rpg`.
- Branch principal: `main`.
- Runtime local vivo pode estar em PM2 como `clover-rpg`.
- Banco vivo local padrao: `banco.sqlite`.
- Site/frontend vive em outro repositorio.

Antes de propor mudanca, leia:

1. `docs/clover/README.md`
2. `docs/clover/mapa-tecnico-backend.md`
3. `docs/clover/matriz-validacao-backend.md`
4. `docs/clover/permissoes-backend.md`
5. `docs/clover/backlog-operacional.md`
6. `docs/clover/riscos-tecnicos-backend.md`
7. `docs/clover/comandos-backend.md`
8. `docs/clover/runbook-banco-vivo.md`

## O que nao tocar durante revisao comum

- `banco.sqlite` vivo.
- PM2, bot WhatsApp, sessao de WhatsApp, QR code e tunel.
- Arquivos de backup, auth, `.env`, tokens e logs locais.
- Branches de runtime/resgate sem motivo claro.
- Scripts com `--apply` sem backup e autorizacao explicita.

## Como validar o estado local

```powershell
git status --short --branch
git fetch origin
git rev-parse HEAD
git rev-parse origin/main
```

Se estiver revisando uma PR, confirme tambem:

```powershell
git branch --show-current
git log --oneline --decorate -10
git diff --stat origin/main...HEAD
```

## Como escolher testes

Use `docs/clover/matriz-validacao-backend.md`.

Regra pratica:

- permissao/cargo: `npm run check:access-permissions` + `npm run test:admin-team`;
- site/API: `npm run test:site-auth` + `npm run test:site-stack`;
- Times de Performance: `npm run test:performance-teams`;
- Mundos dos Sonhos: `npm run test:dream-worlds`;
- capitaes/estrelas: `npm run test:captains-season-stars`;
- mudanca transversal: `npm test`.

Sempre rode:

```powershell
git diff --check
```

## Como revisar uma PR

1. Ler o objetivo da PR.
2. Conferir se a branch nao mistura dominios sem necessidade.
3. Conferir se ha teste novo para regra nova.
4. Conferir se migrations/scripts sao idempotentes.
5. Conferir se qualquer escrita em banco real exige backup.
6. Conferir se permissoes passam pelo contrato oficial.
7. Rodar a suite minima do dominio.
8. Registrar achados com arquivo, linha, risco e reproducao.

## Padrao de comentario esperado

Use achados acionaveis:

```text
Arquivo: helpers/clover/exemploService.js
Risco: duplicacao de recompensa se a mesma chave for enviada duas vezes.
Como reproduzir: teste X ou chamada Y.
Correcao sugerida: consultar idempotency key dentro de BEGIN IMMEDIATE.
```

Evite comentarios genericos como "organizar melhor" sem apontar risco ou
resultado esperado.

## Sinais de bug real

- Player correto sem acesso por diferenca entre telefone e `@lid`.
- Cargo no banco ignorado por lista fixa no comando.
- Recompensa aplicada sem idempotencia.
- Transacao que consulta fora do `BEGIN IMMEDIATE` e escreve depois.
- Script que escreve no banco antes de backup.
- Endpoint publico expondo dado administrativo.
- Mudanca em permissao sem atualizar `check:access-permissions`.

## PRs e trabalhos recentes

Organizacao ja na `main`:
- mapa tecnico;
- contrato de permissoes;
- matriz de validacao;
- backlog operacional;
- guia de revisao.

Times de Performance:
- PR #136 mesclada;
- comandos de bot na `main`;
- fase atual: fila, confirmacao, cancelamento e lista administrativa;
- fase 2 pendente: ciclos, sorteio, votacao, ausencia, historico,
  transferencia e fechamento.

## Como pedir ajuda com seguranca

Ao chamar outra pessoa, envie:

- link da PR ou branch;
- objetivo funcional;
- lista de arquivos alterados;
- comandos ja rodados;
- resultado dos testes;
- o que explicitamente nao pode ser tocado.

Nao envie:

- banco vivo;
- tokens;
- QR code;
- arquivos de sessao WhatsApp;
- numeros privados fora do estritamente necessario.

## Se encontrar problema grave

Pare e reporte antes de corrigir quando houver:

- risco de perda de dados;
- necessidade de migration real;
- duvida sobre regra de produto;
- segredo versionado;
- divergencia entre branch local e remota;
- bot duplicado ou runtime instavel.

Para bug comum com causa clara, corrija em branch propria, adicione teste de
regressao e abra PR em draft.
