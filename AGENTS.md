# CLOVER BOT — instruções persistentes

- GitHub é a verdade do código; Drive/checkpoints são a verdade de decisões/contexto.
- O outro ChatGPT responde por arquitetura, decisões e revisão. Não replaneje o projeto do zero.
- Preserve trabalho local, arquivos untracked e alterações não commitadas.
- Nunca use `git reset --hard` ou `git clean`.
- Não reinicie PM2.
- Não toque DB live, `.env` ou sessão WhatsApp.
- Não execute reset, PRE_RESET, conversão ou repair live.
- Não faça merge, push ou commit sem autorização explícita.
- Antes de alterar código, verifique `git status --short`, branch e HEAD.
- Prefira automação, scripts, rg/grep/AST e testes à inspeção manual repetitiva; confira isolamento antes de executar testes/scripts.
- Trabalhe em lotes pequenos e verificáveis. Consulte `docs/clover/README.md`, o guia de revisão e a matriz de validação; estas restrições prevalecem sobre sugestões operacionais nesses documentos.
- Ao terminar cada lote, reporte apenas: achados novos, arquivos alterados, testes, riscos, `diff --stat` e `status --short`.
