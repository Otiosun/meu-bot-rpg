# Command Center Release Candidate — 2026-08-02

## Escopo incluído

- autorização canônica e escopos administrativos;
- governança de propostas de recompensa de Raid;
- elegibilidade de novos membros e transferência atômica;
- recuperação de operações OP-;
- Equipe ADM canônica AC-;
- Inbox operacional e Histórico unificado;
- integridade econômica de Estrelas;
- Painel do Capitão consumindo o estado atual dos esquadrões.

## Domínio deliberadamente adiado

A migração histórica dos membros veteranos e a substituição definitiva de todos os leitores por `clover_squad_memberships` não fazem parte desta release. Nenhum vínculo existente será apagado ou remapeado por este candidato.

## Invariantes de release

1. Produção não pode ser atualizada sem backup do `banco.sqlite` após o PM2 parar.
2. Somente `clover-rpg` pode ser interrompido durante a janela.
3. O target deve ser validado em worktree isolado antes do checkout do runtime.
4. Qualquer falha após o backup deve restaurar código, banco, PM2 e health.
5. A Inbox e o Histórico são somente leitura.
6. Retry, compensação e aceite parcial exigem ações explícitas e auditáveis.
7. O reconciliador de Estrelas não pode importar `jogadores.estrelas` nem criar lançamentos sintéticos.
8. Saldo negativo no ledger autoritativo deve bloquear reconciliação.
9. Nenhuma interface pode enviar token administrativo pelo navegador.
10. Health final deve responder HTTP 2xx e o runtime deve permanecer no SHA alvo.

## Gates obrigatórios

- autorização canônica;
- membros e transições;
- recuperação operacional;
- Equipe ADM;
- Command Center;
- Estrelas;
- Admin Core;
- Capitães e temporadas;
- Site Auth;
- Site Stack;
- community-exit;
- ciclo de vida do banco;
- sintaxe e whitespace.

## Estado de produção antes da release

- runtime implantado: `608588040dfc3888a7c3ca5f87ddd52e7605104c`;
- último health comprovado: HTTP 200;
- novo código permanece apenas no GitHub até o runbook final ser validado.
