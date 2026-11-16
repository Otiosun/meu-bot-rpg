# Clover: publicação e testes sem expor dados de jogadores

## Estado deste controle
O auditor de `scripts/publicationSafetyAudit.js` é propositalmente **fail-closed**:
- verifica caminhos de arquivos que não podem ser publicados (credenciais, DBs e dados canônicos de identidade);
- procura sinais de identificadores WhatsApp e de chaves privadas em arquivos rastreados;
- consulta caminhos conhecidos do **histórico completo** (`git log --all`) para detectar arquivos sensíveis que já foram versionados;
- **não imprime os valores confidenciais**, apenas categorias e caminhos para revisão.

O teste `tests/publicationSafetyAudit.test.js` usa **somente identificadores artificiais**. A workflow também não usa segredos, dados reais, deploys nem migrações.

## Limitações importantes

Um resultado verde **não significa** que seja seguro publicar o repositório.
- O scanner não examina todos os blobs de commits antigos; ele detecta nomes de arquivo no histórico, mas conteúdo renomeado, mensagens de commit e outros locais precisam de auditoria.
- Remover um arquivo no último commit **não** elimina seu conteúdo do Git antigo.
- Issues, PRs, anexos, caches, forks e logs históricos também devem ser examinados separadamente.
- Credenciais expostas exigem revogação/rotação na origem.
- Dados de terceiros exigem controle específico; não reutilizar identificadores reais como fixtures de teste.

## Abordagem preferida

1. Manter o repositório original **privado** e continuar usando CircleCI Free para testes privados.
2. Para aproveitar GitHub Actions público, criar um **NOVO repositório de testes**, inicialmente vazio e sem importar o histórico original.
3. Copiar apenas os arquivos de código **individualmente revisados**, usando dados sintéticos e removendo referências pessoais.
4. Rodar testes nesse repositório limpo e auditar diffs antes de adicionar novos arquivos.
5. Não habilitar sincronização que copie o repositório privado inteiro; um mirror cego volta a expor os dados.

Esta regra protege os jogadores e não impede que parte do código-fonte do Clover seja de código aberto após a análise de licenças.
