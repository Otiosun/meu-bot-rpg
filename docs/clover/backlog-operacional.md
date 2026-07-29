# Backlog operacional Clover

Este backlog registra pendencias reais conhecidas sem misturar com trabalho ja
publicado. Ele serve para priorizar proximas PRs e para orientar revisao externa.

## Prioridade alta

### Times de Performance no bot

Status:
- esta na `main`;
- PR #136 restaurou o modulo com permissao por cargo real;
- fase atual cobre fila, confirmacao, cancelamento e listagem administrativa.

Problema atual:
- ciclos, sorteio, votacao, ausencia, historico, transferencia e fechamento
  ainda sao fase 2;
- o comando deve responder claramente quando algo ainda nao esta ativo.

Proxima PR:
- implementar ciclo real;
- publicar sorteio assistido;
- confirmar vagas sorteadas;
- historico do ciclo;
- transferencia/substituicao;
- fechamento semanal/mensal.

Validacao minima:

```powershell
npm run check:access-permissions
npm run test:admin-team
npm run test:performance-teams
git diff --check
```

### Aliases `@lid` versus telefone

Status:
- varios fluxos do WhatsApp chegam por `@lid`;
- quando um service usa numero fixo em vez de `normalizeJid`, alias ou cargo do
  banco, a permissao pode falhar para usuario correto.

Regra:
- comando novo deve resolver identidade pelo caminho canonico ja existente;
- permissao operacional deve consultar `accessControlService` ou owner via
  `groupAccess`;
- lista fixa de telefone deve ser excecao temporaria e documentada.

Validacao minima:

```powershell
npm run test:site-auth
npm run check:access-permissions
```

## Prioridade media

### Limpeza local auditavel

Status:
- inventario criado em `docs/clover/inventario-limpeza-local.md`;
- codigo versionado esta limpo;
- o volume grande esta em `backups/` e `artifacts/`;
- nenhuma exclusao foi feita.

Proximo passo:
- decidir quais PRs/branches antigas ainda importam;
- arquivar backups grandes fora do repositorio local com hash;
- remover apenas branches locais ja mescladas e worktrees sem arquivos uteis.

Nao fazer:
- apagar `banco.sqlite`, `auth_info/`, `.env`, configs locais ou backups vivos;
- usar `git clean`, `reset --hard`, `prune` ou force;
- apagar worktree antes de checar status dentro dele.

### Documentar comandos administrativos por modulo

Status:
- `ajuda.js` lista parte dos comandos;
- falta uma pagina tecnica com comandos por dominio, nivel de permissao e risco.

Proximo passo:
- criar `docs/clover/comandos-backend.md`;
- separar player, avaliador, narrador, capitao, admin e owner;
- marcar comandos que escrevem em banco e comandos que exigem backup.

### Runbook de manutencao do banco vivo

Status:
- ha regras espalhadas em runbooks e scripts;
- instaladores recentes ja usam backup, auditoria e rollback.

Proximo passo:
- criar checklist unico para operacoes em `banco.sqlite`;
- listar padrao: fila livre, backup, hash, script, integrity_check, health,
  rollback.

Nao fazer:
- nao criar seeds;
- nao testar INSERT destrutivo no banco vivo;
- nao restaurar backup sem janela autorizada.

### Auditorias legadas de dados

Status:
- existem scripts para identidade, inventario legado, capacidade de feiticos e
  integridade;
- decisoes humanas sobre dados antigos continuam fora do fechamento imediato.

Proximo passo:
- consolidar resultados em um relatorio de saneamento;
- separar correcao automatica segura de decisao narrativa/manual.

Areas:
- caixas;
- inventario;
- titulos;
- titulo ativo;
- feiticos;
- tickets/cupons;
- PA/PM/PH/PR;
- registros BONUS/ITEM antigos;
- registros orfaos;
- duplicacoes.

## Prioridade baixa

### Cloudflare Named Tunnel e dominio

Status:
- decisao atual: manter Quick Tunnel operacional;
- Named Tunnel e dominio ficaram como backlog futuro, nao bloqueante.

Proximo passo futuro:
- escolher dominio;
- criar Named Tunnel;
- guardar credencial fora do Git;
- atualizar Vercel somente em janela autorizada;
- manter rollback para Quick Tunnel.

### Site para Times de Performance

Status:
- primeiro passo deve ser bot/backend;
- frontend fica para uma PR posterior.

Proximo passo:
- depois do service estabilizado, criar API/site para painel publico,
  progresso coletivo e administracao.

## Nao pendente

Itens ja organizados na `main`:
- `.gitignore` para artefatos locais de runtime;
- mapa tecnico do backend;
- contrato de permissoes;
- script `check:access-permissions`;
- guia de revisao backend;
- matriz de validacao por area;
- README tecnico de `docs/clover`.

## Politica de prioridade

Ordem sugerida:

1. Corrigir/entrar Times de Performance por PR propria.
2. Documentar comandos administrativos por permissao.
3. Consolidar runbook de banco vivo.
4. Consolidar auditorias legadas.
5. Deixar Named Tunnel/dominio para janela futura.
