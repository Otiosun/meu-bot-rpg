# Clover Backend

Este diretorio reune a documentacao operacional e tecnica do backend do Clover
RPG. Use como ponto de entrada antes de revisar PRs, mexer em scripts ou tocar
em runtime.

## Ordem recomendada de leitura

1. `mapa-tecnico-backend.md` - fronteiras dos modulos e onde cada dominio mora.
2. `guia-revisao-backend.md` - como revisar o projeto sem tropeçar em areas
   sensiveis.
3. `pacote-revisao-backend.md` - resumo principal para enviar a revisao externa.
4. `matriz-validacao-backend.md` - quais comandos usar por tipo de mudanca.
5. `permissoes-backend.md` - contrato de owner, cargos e permissoes.
6. `backlog-operacional.md` - pendencias reais e proximas PRs.
7. `handoff-revisao-externa.md` - checklist para outra pessoa revisar.
8. `riscos-tecnicos-backend.md` - fragilidades e mitigacoes conhecidas.
9. `comandos-backend.md` - comandos por permissao e risco.
10. `runbook-banco-vivo.md` - manutencao segura do SQLite vivo.
11. `runbook-operacional-site.md` - operacao local do bot/API/tunel.
12. `runbook-publicacao-final.md` - ordem protegida para publicacao autorizada.

## Atalhos por assunto

Arquitetura:
- `mapa-tecnico-backend.md`
- `guia-revisao-backend.md`

Validacao:
- `matriz-validacao-backend.md`
- `package.json`
- `scripts/check-access-permissions-contract.js`

Permissoes:
- `permissoes-backend.md`
- `comandos-backend.md`
- `helpers/groupAccess.js`
- `helpers/clover/accessControlService.js`
- `helpers/clover/accessIntegrationService.js`

Operacao:
- `runbook-banco-vivo.md`
- `runbook-operacional-site.md`
- `runbook-publicacao-final.md`
- `scripts/diagnoseCloverRuntime.js`

Backlog:
- `backlog-operacional.md`

Handoff:
- `pacote-revisao-backend.md`
- `handoff-revisao-externa.md`

Riscos:
- `riscos-tecnicos-backend.md`

Balanceamento e regras de jogo:
- `guia-oficial-cloverscript.txt`
- `guia-raid-eventos.txt`
- `revisao-capacidades-pesos-atual.txt`
- `arvores-para-site-mana-fisico-magia.txt`

## Regras de seguranca

- Nao use o banco vivo em teste destrutivo.
- Nao rode script com `--apply` sem backup e autorizacao explicita.
- Nao reinicie PM2, bot, WhatsApp ou tunel durante revisao comum.
- Nao versionar banco, backup, sessao, token, QR ou `.env`.
- Nao tratar `owner` como cargo de banco.

## Estado dos Times de Performance

Times de Performance ja faz parte da `main` como modulo de bot. A fase atual
cobre fila, confirmacao, cancelamento e listagem administrativa de inscricoes.
Ciclos, sorteio, votacao, ausencia, historico, transferencia e fechamento ficam
para fase posterior.
