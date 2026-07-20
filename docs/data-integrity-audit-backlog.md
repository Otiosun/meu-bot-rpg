# Auditoria de integridade dos dados do Clover

Backlog registrado após a estabilização da Raid V2 e antes de qualquer saneamento automático.

## Escopo

- itens atuais dos jogadores: nomes, categorias, quantidades, propriedades, imagens, duplicações e exemplares legados;
- traços: aptidões comuns e raras, marcas, anomalias, chaves ausentes e textos inconsistentes;
- ganchos narrativos: placeholders, texto corrompido, regressões e campos aprovados que sumiram;
- capacidades: textos genéricos, ausentes, mal formatados ou divergentes entre bot e site;
- perfis e grimórios: campos `-`, aliases duplicados e dados antigos não sincronizados;
- inventário e mercado: modelos sem categoria, condição, qualidade, durabilidade ou imagem coerente.

## Regra de execução

1. gerar relatório somente leitura;
2. separar erro estrutural de escolha legítima do jogador;
3. comparar banco atual, backups e fontes canônicas;
4. criar plano de correção por jogador com antes/depois;
5. aplicar somente correções aprovadas, com backup e trilha auditável;
6. validar site, bot, inventário, mercado, raids e capacidades após cada lote.

Nenhum dado deve ser reescrito em massa sem relatório prévio e possibilidade de reversão.
