# Riscos tecnicos do backend

Este documento lista riscos conhecidos que merecem atencao em revisoes,
publicacoes e operacoes locais. Ele nao e backlog de produto; e um mapa de
fragilidade operacional.

## Banco SQLite vivo

Risco:
- scripts ou comandos escreverem em `banco.sqlite` sem backup consistente;
- migracao parcial deixar schema novo e dados antigos em estado incompatível.

Impacto:
- perda ou corrupcao de inventario, economia, ficha, raids, cargos ou
  identidade.

Como detectar:
- script sem `--db`;
- escrita sem flag explicita;
- ausencia de `VACUUM INTO` ou backup antes da primeira escrita;
- ausencia de `PRAGMA integrity_check` ou auditoria posterior.

Mitigacao:
- usar `helpers/clover/sqliteBackupService.js`;
- rodar em copia isolada antes do banco vivo;
- exigir backup, hash, auditoria e rollback documentado.

## Identidade WhatsApp: telefone, JID e `@lid`

Risco:
- o ator real chegar como `@lid` enquanto o codigo espera telefone ou
  `@s.whatsapp.net`;
- permissoes e comandos usarem numero fixo em vez de resolver identidade
  canonica.

Impacto:
- player correto sem acesso;
- cargo valido ignorado;
- acao administrativa atribuida ao identificador errado.

Como detectar:
- codigo com lista fixa de telefones;
- query direta por telefone em tabela que usa `id` canonico;
- reclamacao de player com cargo ativo recebendo mensagem de bloqueio.

Mitigacao:
- usar `normalizeJid`, aliases e services de identidade existentes;
- consultar `accessControlService` para permissao;
- cobrir teste com `@lid`.

## Permissoes fora do contrato

Risco:
- novo comando checar ADM de grupo, telefone fixo ou texto de cargo sem passar
  pelo contrato oficial.

Impacto:
- acesso indevido;
- admin real bloqueado;
- auditoria impossivel de rastrear.

Como detectar:
- `participant.admin` como unica regra para sistema de RPG;
- `isOwner` usado onde cargo `admin`, `evaluator`, `captain` ou permissao
  escopada seria necessario;
- mudanca em permissoes sem atualizar `scripts/check-access-permissions-contract.js`.

Mitigacao:
- usar `helpers/clover/accessControlService.js`;
- usar `helpers/clover/accessIntegrationService.js`;
- rodar `npm run check:access-permissions`.

## Idempotencia de economia e recompensas

Risco:
- abertura de caixa, resgate, compra, recompensa ou aprovacao ser executada duas
  vezes por retry, clique duplo ou concorrencia.

Impacto:
- duplicacao de item, moeda, PH/PR/PA ou estrela;
- consumo duplo de recurso;
- historico financeiro inconsistente.

Como detectar:
- service escreve sem `idempotencyKey`;
- consulta de chave fora da transacao;
- ausencia de teste de repeticao/concorrrencia.

Mitigacao:
- chave obrigatoria nos fluxos criticos;
- consulta e escrita dentro de `BEGIN IMMEDIATE`;
- retorno `duplicate` para mesma chave/mesmo ator;
- teste com duas submissões concorrentes.

## Divergencia entre tabelas novas e campos legados

Risco:
- tabela nova representar estado oficial, mas campo legado continuar diferente
  em `jogadores`.

Impacto:
- recompensas irem para esquadrao errado;
- acesso de capitao/vice ficar incorreto;
- frontend mostrar estado diferente do bot.

Como detectar:
- service usa `jogadores.esquadrao` quando ja existe membership versionado;
- migration de personagem depois de uma proposta muda beneficiario;
- teste passa em tabela nova, mas falha no comando legado.

Mitigacao:
- congelar snapshot no momento da proposta;
- validar divergencia antes de aprovar/remover;
- manter testes para campos legados e nova tabela.

## Runtime PM2 e bot duplicado

Risco:
- iniciar outro bot ou outro stack enquanto `clover-rpg` esta online;
- mexer em MudZap/MudZap-ngrok por engano.

Impacto:
- sessoes WhatsApp conflitantes;
- respostas duplicadas;
- tunnel quebrado;
- estado operacional dificil de restaurar.

Como detectar:
- mais de uma instancia do bot;
- `pm2 list` com nomes inesperados;
- logs de reconexao ou QR novo sem autorizacao.

Mitigacao:
- identificar processo real antes de parar/reiniciar;
- nunca usar `pm2 delete` em manutencao comum;
- reiniciar somente processo confirmado e em janela autorizada.

## Quick Tunnel temporario

Risco:
- Cloudflare Quick Tunnel trocar URL em restart;
- Vercel apontar para URL antiga;
- tentativa de Named Tunnel incompleta quebrar o caminho atual.

Impacto:
- site em producao perde upstream;
- API local saudavel, mas publico inacessivel.

Como detectar:
- logs do `clover-rpg` mostram nova URL trycloudflare;
- health local 200 e health publico falhando;
- `CLOVER_API_UPSTREAM` desatualizado.

Mitigacao:
- manter decisao atual documentada;
- nao executar `cloudflared tunnel login` nesta remessa;
- atualizar Vercel apenas com autorizacao;
- registrar URL ativa em relatorio operacional.

## Scripts operacionais com `--apply`

Risco:
- operador rodar aplicacao real pensando estar em preview.

Impacto:
- alteracao irreversivel ou trabalhosa em banco vivo.

Como detectar:
- script sem modo preview;
- flag de confirmacao fraca;
- saida sem listar banco, backup e plano.

Mitigacao:
- bloquear escrita sem confirmacao literal;
- exigir `--db`;
- imprimir caminho do banco, backup, totais e rollback;
- manter testes do instalador/executor.

## Exposicao de dados privados

Risco:
- endpoint publico ou log expor telefone, JID, token, codigo de login, motivo
  administrativo ou dado privado de avaliacao.

Impacto:
- vazamento de identidade;
- abuso de login;
- perda de confianca dos players.

Como detectar:
- resposta publica inclui campo tecnico;
- testes nao diferenciam publico/admin;
- logs imprimem payload integral de auth.

Mitigacao:
- mascarar identidades em relatorio;
- separar serializers publico/admin;
- testar privacidade de payload.

## Fila lenta de economia

Risco:
- mutacoes demoradas acumularem fila e gerarem timeout/retry.

Impacto:
- player repetir comando achando que falhou;
- aumento de chance de colisao ou duplicacao se idempotencia faltar.

Como detectar:
- logs `[economy-queue] slow_mutation` ou `slow_read`;
- `health` com `queue.active=true` por tempo alto.

Mitigacao:
- health antes de manutencao;
- idempotencia em todas as mutacoes;
- investigar consultas lentas quando virar padrao, nao evento isolado.

## Branches de resgate e trabalho arquivado

Risco:
- copiar codigo de branch arquivada sem adaptar ao contrato atual;
- misturar PRs de dominios diferentes.

Impacto:
- regressao de permissao;
- numero real ou workaround antigo voltar para a main;
- PR dificil de revisar.

Como detectar:
- branch com arquivos de Times dentro de PR de capitaes, raids ou runtime;
- diff contendo regras antigas ou lista fixa;
- testes removidos ou fora do script npm.

Mitigacao:
- branch propria por dominio;
- PR em draft;
- diff pequeno;
- varredura de strings sensiveis antes do commit.
