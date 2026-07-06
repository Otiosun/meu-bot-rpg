# Revisao de Balanceamento das Arvores - v1

Documento de analise para a Fase 8B. Ele revisa `manual-nos-ranks-v1.md` e `manual-nos-ranks-v1.json`, mas nao altera runtime, JSONs ativos, custos reais, PH, compra de no, renderers ou PM2.

## 1. Premissas

- O limite comum de treino por ciclo/reino considerado nesta simulacao e de 40 PH.
- O treino comum medio considerado e de 15 PH.
- Missoes ficam fora da simulacao. Elas podem pagar mais PH, mas nao devem guiar o custo base das arvores.
- A regua usada como referencia e: 15 PH para base/entrada, 25 PH para Rank I ou uso inicial real, 40 PH para Rank II e uso confiavel, 60 PH para Rank III, 80 PH para avancado/gateway forte, 100+ PH para topo/proibido/zona/maldicao/efeitos extremos.
- Quando um caminho tem Rank I/II/III, Rank II deve ser o ponto comum de liberacao de filhos. Rank III melhora o uso, mas nao deve travar todo avanco.
- Onde o manual traz custo em faixa, esta revisao escolhe o menor valor para no simples e o maior valor para no amplo, externo, persistente, proibido ou de escala.

## 2. Resumo Geral

| Arvore | Nos analisados | Estado de estabilidade | Cuidado principal |
|---|---:|---|---|
| Mana | 57 | Mais estavel. A estrutura ja separa rotas, ranks e topo com boa leitura. | Zona, Dominio, Metodo, Dominador e Mana Ambiente precisam continuar narrativos. |
| Suporte | 21 | Mais problematica. A arvore e poderosa, vaga em alguns pontos e ainda bloqueada para compra. | Pode quebrar cena por cura, selo, condicao, restricao, absorcao, maldicao, praga e buff/debuff acumulado. |
| Criacao | 28 | Estavel se mantida como manifestacao magica, nao corpo. | Juncao de Forma, Formas Humanoides e Ambiente precisam marco quando virarem escala/automatismo. |
| Reforco | 25 | Estavel em autobuff simples. Fica sensivel em buff externo/coletivo. | Invicto, Distancia, Coletivo e Reforco Avancado devem ter trava narrativa. |

Mana parece a arvore mais madura. Suporte exige a revisao mais cuidadosa antes de qualquer liberacao parcial.

## 3. Tabela Geral de Nos

| Arvore | No | Tipo | Rank Max. | Custo sugerido | Libera filhos em | Requisito narrativo | Compra agora? | Risco |
|---|---|---|---|---|---|---|---|---|
| Mana | MANA | base | unico | 15 | unico | livre | sim | baixo |
| Mana | Percepcao de Mana | rota | unico | 15 | unico | livre | sim | baixo |
| Mana | Fluxo de Mana | rota | unico | 15 | unico | livre | sim | baixo |
| Mana | Retencao de Mana | rota | unico | 15 | unico | livre | sim | baixo |
| Mana | Emissao de Mana | rota | unico | 15 | unico | livre | sim | baixo |
| Mana | Sentir Mana I | tecnica | serie III | 25 | Rank II | livre | sim | baixo |
| Mana | Sentir Mana II | tecnica | serie III | 40 | sim | treino registrado | sim | baixo |
| Mana | Sentir Mana III | tecnica | serie III | 60 | melhoria | treino/marco | sim | medio |
| Mana | Leitura de Flutuacao | tecnica | unico | 40 | unico | treino registrado | sim | baixo |
| Mana | Assinatura Magica | tecnica | unico | 60 | unico | treino/marco | sim | medio |
| Mana | Campo de Mana I | tecnica | serie III | 25 | Rank II | treino | sim | baixo |
| Mana | Campo de Mana II | tecnica | serie III | 40 | sim | treino | sim | baixo |
| Mana | Campo de Mana III | tecnica | serie III | 60 | melhoria | marco | sim | medio |
| Mana | Circulacao | tecnica | unico | 25 | unico | livre | sim | baixo |
| Mana | Estabilidade | tecnica | unico | 40 | unico | treino | sim | baixo |
| Mana | Canalizacao | tecnica | unico | 40 | unico | treino | sim | baixo |
| Mana | Ritmo de Mana | tecnica | unico | 40 | unico | treino | sim | baixo |
| Mana | Pele de Mana I | tecnica | serie III | 25 | Rank II | treino | sim | baixo |
| Mana | Pele de Mana II | tecnica | serie III | 40 | sim | treino | sim | medio |
| Mana | Pele de Mana III | tecnica | serie III | 60 | melhoria | marco | sim | medio |
| Mana | Manto de Mana | avancado | unico | 80 | unico | marco | sim | alto |
| Mana | Controle Fino I | tecnica | serie III | 25 | Rank II | treino | sim | baixo |
| Mana | Controle Fino II | tecnica | serie III | 40 | sim | treino | sim | baixo |
| Mana | Controle Fino III | tecnica | serie III | 60 | melhoria | marco | sim | medio |
| Mana | Compressao de Mana | avancado | unico | 80 | unico | marco | sim | alto |
| Mana | Voo de Vassoura | tecnica | unico | 40 | unico | treino | sim | medio |
| Mana | Revestimento de Objeto | tecnica | unico | 40 | unico | treino | sim | medio |
| Mana | Manutencao Simultanea | avancado | unico | 100 | unico | marco | sim | alto |
| Mana | Economia I | tecnica | serie III | 25 | Rank II | livre/treino | sim | baixo |
| Mana | Economia II | tecnica | serie III | 40 | sim | treino | sim | baixo |
| Mana | Economia III | tecnica | serie III | 60 | melhoria | marco | sim | medio |
| Mana | Recuperacao I | tecnica | serie III | 25 | Rank II | livre/treino | sim | baixo |
| Mana | Recuperacao II | tecnica | serie III | 40 | sim | treino | sim | medio |
| Mana | Recuperacao III | tecnica | serie III | 60 | melhoria | marco | sim | medio |
| Mana | Ocultacao de Mana | tecnica | unico | 80 | unico | marco | sim | alto |
| Mana | Nucleo de Mana | avancado | unico | 80 | unico | marco | sim | alto |
| Mana | Leitura Ambiental | tecnica | unico | 60 | unico | treino/marco | sim | medio |
| Mana | Adaptacao Ambiental | tecnica | unico | 80 | unico | marco | sim | alto |
| Mana | Mana Ambiente I | avancado | serie III | 80 | Rank II | marco | sim | alto |
| Mana | Mana Ambiente II | avancado | serie III | 100 | sim | marco | sim | alto |
| Mana | Mana Ambiente III | avancado | serie III | 120 | melhoria | marco forte | sim | extremo |
| Mana | Ressonancia | avancado | unico | 100 | unico | marco | sim | alto |
| Mana | Metodo de Mana | gateway | unico | 120 | unico | marco forte | sim | extremo |
| Mana | Bala de Mana I | tecnica | serie III | 25 | Rank II | livre/treino | sim | baixo |
| Mana | Bala de Mana II | tecnica | serie III | 40 | sim | treino | sim | medio |
| Mana | Bala de Mana III | tecnica | serie III | 60 | melhoria | marco | sim | medio |
| Mana | Pulso de Mana I | tecnica | serie III | 25 | Rank II | treino | sim | baixo |
| Mana | Pulso de Mana II | tecnica | serie III | 40 | sim | treino | sim | medio |
| Mana | Pulso de Mana III | tecnica | serie III | 60 | melhoria | marco | sim | medio |
| Mana | Pressao de Mana | avancado | unico | 80 | unico | marco | sim | alto |
| Mana | Condutor | gateway | unico | 100 | unico | marco | sim | alto |
| Mana | Reservatorio | gateway | unico | 100 | unico | marco | sim | alto |
| Mana | Dominador | topo | unico | 120 | unico | marco forte | sim | extremo |
| Mana | Zona de Mana I | proibido/topo | serie III | 120 | Rank II | proibido/especial | aprovacao | extremo |
| Mana | Zona de Mana II | proibido/topo | serie III | 120 | sim | proibido/especial | aprovacao | extremo |
| Mana | Zona de Mana III | proibido/topo | serie III | 120 | melhoria | proibido/especial | aprovacao | extremo |
| Mana | Dominio de Mana | topo | unico | 120 | unico | proibido/especial | aprovacao | extremo |
| Suporte | Suporte | base | unico | 15 | unico | livre | bloqueada | medio |
| Suporte | Magigramatica | rota/tecnica | III | 25/40/60 | Rank II | livre/treino/marco | bloqueada | medio |
| Suporte | Praga | tecnica perigosa | III | 80/100/120 | Rank I com marco | marco/proibido | bloqueada | extremo |
| Suporte | Bencao | tecnica | III | 25/40/60 | Rank II | livre/treino/marco | bloqueada | medio |
| Suporte | Selo | tecnica | III | 25/40/60 | Rank II | treino/marco | bloqueada | alto |
| Suporte | Comunicacao | tecnica | III | 25/40/60 | Rank II | livre/treino/marco | bloqueada | medio |
| Suporte | Juncao de Forma | gateway | unico | 80 | unico | marco narrativo | bloqueada | alto |
| Suporte | Transformacao | tecnica | III | 25/40/60 | Rank II | treino/marco | bloqueada | alto |
| Suporte | Armadilha | tecnica | III | 25/40/60 | Rank II | treino/marco | bloqueada | alto |
| Suporte | Condicao | tecnica | III | 25/40/60 | Rank II | treino/marco | bloqueada | alto |
| Suporte | M. Proibida | proibido/gateway | unico | 120 | unico | proibido/especial | bloqueada | extremo |
| Suporte | Maldicao | proibido | unico | 120 | unico | proibido/especial | bloqueada | extremo |
| Suporte | Ilusao | tecnica sensivel | III | 25/40/60 | Rank II | livre/treino/marco | bloqueada | alto |
| Suporte | Absorcao | tecnica sensivel | III | 80/100/120 | Rank II | marco/proibido | bloqueada | extremo |
| Suporte | Enfraquecimento | tecnica | III | 25/40/60 | Rank II | treino/marco | bloqueada | alto |
| Suporte | Restricao | tecnica sensivel | III | 25/40/60 | Rank II | marco narrativo | bloqueada | extremo |
| Suporte | Debuff | tecnica | III | 25/40/60 | Rank II | livre/treino/marco | bloqueada | alto |
| Suporte | Efeito | tecnica | III | 25/40/60 | Rank II | livre/treino/marco | bloqueada | alto |
| Suporte | Cura | tecnica sensivel | III | 25/40/60 | Rank II | treino/marco | bloqueada | alto |
| Suporte | Transmissao | tecnica | III | 25/40/60 | Rank II | treino/marco | bloqueada | alto |
| Suporte | Buff | tecnica | III | 25/40/60 | Rank II | livre/treino/marco | bloqueada | alto |
| Criacao | Criacao | base | unico | 15 | unico | livre | sim | baixo |
| Criacao | Controle | gateway | unico | 15 | unico | livre | sim | baixo |
| Criacao | Defesa Magica I | upgrade | serie III | 25 | Rank II | livre | sim | baixo |
| Criacao | Defesa Magica II | upgrade | serie III | 40 | sim | treino registrado | sim | baixo |
| Criacao | Defesa Magica III | upgrade | serie III | 60 | melhoria | treino/marco | sim | medio |
| Criacao | Velocidade Magica I | upgrade | serie III | 25 | Rank II | livre | sim | baixo |
| Criacao | Velocidade Magica II | upgrade | serie III | 40 | sim | treino registrado | sim | baixo |
| Criacao | Velocidade Magica III | upgrade | serie III | 60 | melhoria | treino/marco | sim | medio |
| Criacao | Forca Magica I | upgrade | serie III | 25 | Rank II | livre | sim | baixo |
| Criacao | Forca Magica II | upgrade | serie III | 40 | sim | treino registrado | sim | baixo |
| Criacao | Forca Magica III | upgrade | serie III | 60 | melhoria | treino/marco | sim | medio |
| Criacao | Estrutura | gateway | unico | 15 | unico | livre | sim | baixo |
| Criacao | Densidade I | upgrade | serie III | 25 | Rank II | livre | sim | baixo |
| Criacao | Densidade II | upgrade | serie III | 40 | sim | treino registrado | sim | baixo |
| Criacao | Densidade III | upgrade | serie III | 60 | melhoria | treino/marco | sim | medio |
| Criacao | Precisao I | upgrade | serie III | 25 | Rank II | livre | sim | baixo |
| Criacao | Precisao II | upgrade | serie III | 40 | sim | treino registrado | sim | baixo |
| Criacao | Precisao III | upgrade | serie III | 60 | melhoria | treino/marco | sim | medio |
| Criacao | Juncao de Forma | gateway | unico | 80 | unico | marco se complexo | sim | alto |
| Criacao | Armas | tecnica | serie III | 25 | Rank II | livre/treino | sim | medio |
| Criacao | Armas II | tecnica | serie III | 40 | sim | treino registrado | sim | medio |
| Criacao | Armas III | tecnica | serie III | 80 | melhoria | marco narrativo | sim | alto |
| Criacao | Formas Humanoides | tecnica | serie III | 25 | Rank II | treino registrado | sim | medio |
| Criacao | Formas Humanoides II | tecnica | serie III | 60 | sim | marco narrativo | sim | alto |
| Criacao | Formas Humanoides III | tecnica | serie III | 80 | melhoria | marco narrativo | sim | alto |
| Criacao | Ambiente | tecnica | serie III | 25 | Rank II | treino registrado | sim | medio |
| Criacao | Ambiente II | tecnica | serie III | 60 | sim | marco narrativo | sim | alto |
| Criacao | Ambiente III | tecnica | serie III | 80 | melhoria | marco narrativo | sim | alto |
| Reforco | Reforco | base | unico | 15 | unico | livre | sim | baixo |
| Reforco | Intensidade I | upgrade | serie III | 25 | Rank II | livre | sim | baixo |
| Reforco | Intensidade II | upgrade | serie III | 40 | sim | treino registrado | sim | medio |
| Reforco | Intensidade III | upgrade | serie III | 60 | melhoria | treino/marco | sim | medio |
| Reforco | Estabilidade I | upgrade | serie III | 25 | Rank II | livre | sim | baixo |
| Reforco | Estabilidade II | upgrade | serie III | 40 | sim | treino registrado | sim | medio |
| Reforco | Estabilidade III | upgrade | serie III | 60 | melhoria | treino/marco | sim | medio |
| Reforco | Foco de Atributo | gateway | escada | 25 | unico | livre | sim | baixo |
| Reforco | Duplo Foco | upgrade | escada | 40 | sim | treino registrado | sim | medio |
| Reforco | Multiplo Foco | upgrade | escada | 60 | melhoria | marco narrativo | sim | alto |
| Reforco | Invencivel | gateway | unico | 25 | unico | livre/treino | sim | baixo |
| Reforco | Forca Reforcada | permissao | unico | 25 | unico | livre | sim | baixo |
| Reforco | Velocidade Reforcada | permissao | unico | 25 | unico | livre | sim | baixo |
| Reforco | Agilidade Reforcada | permissao | unico | 25 | unico | livre | sim | baixo |
| Reforco | Resistencia Reforcada | permissao | unico | 25 | unico | livre | sim | baixo |
| Reforco | Defesa Reforcada | permissao | unico | 25 | unico | livre | sim | baixo |
| Reforco | Invicto | gateway | unico | 80 | unico | marco narrativo | sim | alto |
| Reforco | Reforco por Toque | tecnica | escada | 40 | unico | treino registrado | sim | medio |
| Reforco | Reforco a Distancia | tecnica | escada | 80 | unico | marco narrativo | sim | alto |
| Reforco | Reforco Coletivo | avancado | escada | 100 | unico | marco narrativo | sim | extremo |
| Reforco | Juncao de Forma | gateway | unico | 80 | unico | marco se complexo | sim | alto |
| Reforco | Reforco Avancado | avancado | unico | 80 | unico | marco narrativo | sim | alto |
| Reforco | Reforco Avancado: Armas | avancado | unico | 80 | unico | marco narrativo | sim | alto |
| Reforco | Reforco Avancado: Formas Humanoides | avancado | unico | 100 | unico | marco narrativo | sim | extremo |
| Reforco | Reforco Avancado: Ambiente | avancado | unico | 120 | unico | marco narrativo | sim | extremo |

## 4. Suporte - Revisao Prioritaria

Suporte precisa continuar bloqueada ate a Fase 8C aplicar custo, requisito narrativo e descricoes finais. O risco nao vem de dano bruto, mas de controle de cena: efeitos persistentes, regras condicionais, anulacao, cura, travas, transmissao de efeito, acumulacao de buff/debuff e caminhos proibidos.

Magigramatica deve ser tratada como gramatica/matematica da magia: magia como linguagem, formula, simbolo, regra, estrutura e condicao. Ela nao deve virar "suporte generico"; ela e a base tecnica para escrever, programar e condicionar efeitos.

| No | Rank Max. | Custo sugerido | Libera filhos em | Narrativo | Compra agora? | Observacao |
|---|---:|---|---|---|---|---|
| Suporte | 1 | 15 | unico | livre | nao | Base conceitual. Pode ser liberada futuramente, mas sem efeitos fortes sozinha. |
| Magigramatica | 3 | 25/40/60 | Rank II | I livre, II treino, III marco | nao | Bem definida. Deve abrir Selo, Comunicacao, Condicao/Bencao e formulas simples no Rank II. |
| Selo | 3 | 25/40/60 | Rank II | treino/marco | nao | Precisa descricao operacional: armazenar, ativar, travar ou condicionar. Selo II deve ser o primeiro realmente confiavel. |
| Comunicacao | 3 | 25/40/60 | Rank II | livre/treino/marco | nao | Baixo risco se for sinal/mensagem; alto risco se virar rede, telepatia ou rastreio sem limite. |
| Juncao de Forma | 1 | 80 | unico | marco narrativo | nao | Gateway unico. Nao comprar livre ate definir interacao com Criacao/Reforco. |
| Transformacao | 3 | 25/40/60 | Rank II | treino/marco | nao | Vago demais. Precisa limitar a transformacao ao atributo magico e ao suporte adquirido. |
| Armadilha | 3 | 25/40/60 | Rank II | treino/marco | nao | Pode quebrar cena se gatilho for perfeito. Exigir condicao clara, alcance, duracao e falha possivel. |
| Condicao | 3 | 25/40/60 | Rank II | treino/marco | nao | Muito forte. Condicao III nao pode virar contrato absoluto sem caminho proibido. |
| M. Proibida | 1 | 120 | unico | proibido/especial | nao | Deve ficar bloqueada. Exige evento, permissao direta ou arco especifico. |
| Maldicao | 1 | 120 | unico | proibido/especial | nao | Bloqueada. Persistencia, dano indireto e efeito espiritual exigem controle humano. |
| Ilusao | 3 | 25/40/60 | Rank II | treino/marco | nao | Deve afetar percepcao limitada, nao controle mental total. |
| Absorcao | 3 | 80/100/120 | Rank II | marco/proibido | nao | Perigosa demais para custo 25 inicial. Sugestao: Rank I ja custa 80 e exige marco. |
| Enfraquecimento | 3 | 25/40/60 | Rank II | treino/marco | nao | Deve reduzir eficiencia, nao anular personagem. |
| Restricao | 3 | 25/40/60 | Rank II | marco narrativo | nao | Alto risco. Nao liberar paralisia total ou bloqueio magico pleno sem ADM. |
| Debuff | 3 | 25/40/60 | Rank II | treino/marco | nao | Precisa regra anti-acumulo. Debuff III deve ser forte, mas nao substituir Praga/Maldicao. |
| Praga | 3 | 80/100/120 | Rank I com marco | marco/proibido | nao | Deve sair do fluxo livre. O JSON atual ligar Praga direto em Suporte e fragil. |
| Bencao | 3 | 25/40/60 | Rank II | livre/treino/marco | nao | Boa se for buff positivo limitado. Nao deve apagar custo, ferida ou consequencia. |
| Cura | 3 | 25/40/60 | Rank II | treino/marco | nao | Sensivel. Cura I leve; Cura II moderada; Cura III forte, sem negar morte/trauma grave. |
| Efeito | 3 | 25/40/60 | Rank II | treino/marco | nao | Vago demais. Deve ser no coringa com descricao obrigatoria e aprovacao em usos amplos. |
| Buff | 3 | 25/40/60 | Rank II | livre/treino/marco | nao | Exige regra anti-stack e limite por cena. |
| Transmissao | 3 | 25/40/60 | Rank II | treino/marco | nao | Pode quebrar por espalhar buff/debuff/cura. Limitar alvo, distancia, vinculo e duracao. |

Diagnostico: Suporte pode ser liberada parcialmente na 8C somente se os nos seguros ficarem separados dos nos proibidos. Uma liberacao inicial aceitavel seria Suporte, Magigramatica I/II, Comunicacao I, Bencao I, Buff I, Selo I e talvez Cura I. Praga, Maldicao, M. Proibida, Absorcao, Restricao, Condicao III, Transmissao III e qualquer efeito persistente devem continuar bloqueados ou exigir aprovacao.

## 5. Criacao - Revisao

Criacao esta coerente quando mantida como manifestacao magica: forma, controle, estrutura, precisao, densidade, forca magica, velocidade magica, armas, formas humanoides e ambiente. Ela nao deve buffar corpo.

Pontos confirmados:

- Criacao melhora manifestacao magica, nao atributos fisicos do personagem.
- Criacao nao substitui Reforco.
- Armas I nao e necessario para criar espada simples; Armas I melhora especializacao em armas magicas.
- Ambiente I nao e necessario para nevoa pequena; Ambiente I melhora controle de area/campo.
- Focos melhoram manifestacoes especializadas, principalmente quando a forma deixa de ser simples.

Revisao pratica:

| Grupo | Avaliacao | Recomendacao |
|---|---|---|
| Criacao, Controle, Estrutura | Bem definidos | Custo 15 e bom para entrada. |
| Defesa/Velocidade/Forca Magica I/II/III | Bem definidos | Manter 25/40/60. Rank II libera uso confiavel. |
| Densidade/Precisao I/II/III | Bem definidos | Manter 25/40/60. |
| Juncao de Forma | Sensivel | Custo 80; compra pode existir, mas uso complexo deve exigir marco. |
| Armas I/II/III | Bem definidos | 25/40/80. Armas III deve pedir marco. |
| Formas Humanoides I/II/III | Sensivel | 25/60/80. II e III precisam marco por autonomia/corpo magico. |
| Ambiente I/II/III | Sensivel | 25/60/80. II e III precisam marco por escala de cena. |

Problema principal: se Juncao de Forma, Formas Humanoides e Ambiente forem usados sem limite, a arvore vira invocacao, terreno, armadura ou automacao completa cedo demais.

## 6. Reforco - Revisao

Reforco esta coerente como buff de corpo, atributos fisicos ou aliados. Ele nao deve buffar projetil/criacao magica comum; isso e papel de Criacao.

Pontos confirmados:

- Reforco buffa corpo, atributos fisicos e, em rota propria, aliados.
- Reforco nao melhora uma bala magica, construto comum ou projetil criado.
- Atributos reforcados nao precisam I/II/III proprios agora.
- A forca do buff vem de Intensidade, Estabilidade, Foco, Hexagono e contexto.

Revisao pratica:

| Grupo | Avaliacao | Recomendacao |
|---|---|---|
| Intensidade I/II/III | Bem definido | Manter 25/40/60. |
| Estabilidade I/II/III | Bem definido | Manter 25/40/60. |
| Foco/Duplo/Multiplo | Bem definido | 25/40/60. Multiplo pede marco. |
| Invencivel + atributos reforcados | Estavel | Permissoes de 25 PH funcionam porque potencia vem de Intensidade/Estabilidade. |
| Invicto | Sensivel | Recomendado 80 PH e marco antes de buff real em aliados. |
| Toque/Distancia/Coletivo | Sensivel | 40/80/100. Coletivo deve ser narrativo. |
| Reforco Avancado | Sensivel | 80+ e marco obrigatorio. |
| Ambiente/Formas Humanoides avancados | Perigoso | 100+ e controle humano. |

Problema principal: buff em aliados escala muito rapido em cena de grupo. Se Invicto custar 40 e liberar Toque/Distancia/Coletivo cedo, o sistema vira multiplicador de party antes do tempo.

## 7. Mana - Revisao

Mana esta coerente com o manual e com o que ja foi aplicado. Nao ha recomendacao de refactor grande.

Pontos revisados:

- Rotas de entrada podem ficar em 15 PH: Percepcao, Fluxo, Retencao e Emissao.
- Series I/II/III estao coerentes em 25/40/60.
- Tecnicas puras devem manter os pesos ja definidos: Bala I/II/III peso 2/4/6, Pulso I/II/III peso 2/4/6, Pele ativa peso 2, Manto peso 5.
- Mana Ambiente, Zona, Dominio, Metodo e Dominador precisam continuar narrativos.
- Manutencao Simultanea, Ocultacao, Nucleo, Ressonancia, Condutor e Reservatorio sao nos de alto impacto e devem ficar em 80/100.

Revisao por risco:

| Grupo | Custo sugerido | Narrativo | Risco |
|---|---|---|---|
| Entrada e rotas | 15 | livre | baixo |
| Tecnicas I/II/III comuns | 25/40/60 | livre/treino/marco | baixo/medio |
| Manto, Compressao, Pressao, Nucleo, Adaptacao | 80 | marco | alto |
| Mana Ambiente II/III, Ressonancia, Condutor, Reservatorio | 100+ | marco forte | alto |
| Zona, Dominio, Metodo, Dominador | 120+ | proibido/especial | extremo |

## 8. Simulacao de Rotas

Formula usada: ciclos = teto(custo total / 40). Treinos medios = teto(custo total / 15).

| Rota | Custo total | Ciclos no limite 40 PH | Treinos medios 15 PH | Requisito narrativo? | Comentario |
|---|---:|---:|---:|---|---|
| Mana - Emissao basica: MANA -> Emissao -> Bala I -> Bala II -> Bala III -> Pressao | 235 | 6 | 16 | Sim, Pressao e Bala III pedem marco/treino forte | Boa progressao. Chega a projeteis fortes em 4 ciclos e pressao no 6. |
| Criacao - Controle ofensivo: Criacao -> Controle -> Forca I -> II -> III | 155 | 4 | 11 | Sim, Forca III pede treino/marco | Boa rota inicial. Nao parece cara demais. |
| Criacao - Especialista em Formas: Criacao -> Juncao -> Formas I -> II -> III | 260 | 7 | 18 | Sim, Juncao/Formas II/III | Correta por ser rota de construtos/corpos. Nao deve ficar mais barata sem controle narrativo. |
| Reforco - Autobuff fisico: Reforco -> Intensidade I -> Estabilidade I -> Foco -> Invencivel -> Forca Reforcada | 155 | 4 | 11 | Leve, principalmente treino | Estavel. Potencia ainda depende de Intensidade/Estabilidade. |
| Reforco - Buff em aliados: Reforco -> Invicto -> Toque -> Distancia -> Coletivo | 315 | 8 | 21 | Sim, de Invicto em diante | Deve ser caro mesmo. Buff coletivo e multiplicador de cena. |
| Suporte - Selo basico funcional: Suporte -> Magigramatica I -> Magigramatica II -> Selo I | 105 | 3 | 7 | Sim, treino para Magigramatica II/Selo | Bom primeiro pacote de Suporte se a 8C liberar parcialmente. |
| Suporte - Praga: Suporte -> Magigramatica II -> M. Proibida -> Debuff II -> Praga I | 275 | 7 | 19 | Sim, proibido/especial | Rota teorica. Deveria permanecer bloqueada e exigir permissao direta. |
| Suporte - Cura: Suporte -> Bencao I -> Cura I -> Cura II -> Cura III | 165 | 5 | 11 | Sim, Cura II/III | Custo bom, mas Cura III precisa nao negar morte/trauma sem ADM. |

Leitura rapida:

- Rotas basicas ficam entre 3 e 4 ciclos, o que e saudavel.
- Rotas avancadas ficam entre 6 e 8 ciclos, o que preserva progressao.
- Suporte proibido e buff coletivo precisam ficar caros e narrativos.

## 9. Problemas Encontrados

- Suporte tem nos vagos demais: Efeito, Transformacao, Condicao, Transmissao e Juncao de Forma precisam descricao operacional antes de compra.
- Suporte tem nos perigosos demais para compra livre: M. Proibida, Maldicao, Praga, Absorcao, Restricao, Condicao III, Transmissao III e Cura III.
- O custo 25/40/60 e baixo demais para Absorcao e Praga se forem persistentes ou drenarem recursos importantes. Sugestao: 80/100/120.
- Praga no JSON atual aparece como rota direta de Suporte, mas o briefing trata como consequencia de Debuff/caminho proibido. Isso e divergencia importante.
- Bencao no JSON atual aparece direta em Suporte, enquanto o briefing a coloca no tronco formulado por Magigramatica. Isso pode ser aceitavel se Bencao I for simples, mas efeitos fortes devem pedir formula/condicao.
- Selo pode quebrar cena se armazenar qualquer efeito sem limite de duracao, carga, alvo, alcance e condicao.
- Reforco em aliados pode quebrar cenas de grupo se Invicto, Distancia e Coletivo ficarem baratos.
- Criacao pode escapar do escopo se Formas Humanoides e Ambiente virarem autonomia completa cedo demais.
- Mana nao tem problema estrutural grande, mas Zona/Dominio/Metodo/Dominador precisam continuar sob aprovacao.
- CapacityService atualmente nao le Suporte. Isso e correto por enquanto; Suporte precisa de balanceamento antes de entrar em capacidade tecnica.
- Arvore visual e logica precisam continuar sincronizadas, principalmente se Suporte for reorganizada na 8C.

## 10. Recomendacoes para Fase 8C

- Aplicar custos nos JSONs ativos somente depois de aprovar esta revisao.
- Manter compra de Suporte bloqueada ate separar nos seguros, sensiveis e proibidos.
- Liberar Suporte parcialmente apenas para pacote inicial seguro: Suporte, Magigramatica I/II, Comunicacao I, Selo I, Bencao I, Buff I e Cura I, se a ADM aprovar.
- Manter M. Proibida, Maldicao, Praga, Absorcao, Restricao, Condicao III e Transmissao III bloqueados ou dependentes de aprovacao narrativa.
- Ajustar Praga para nao ser caminho direto simples de Suporte, ou registrar explicitamente que Praga direta exige marco/proibido.
- Melhorar descricoes de `.#no suporte <no>` antes de liberar compra.
- Criar regra anti-acumulo para Buff, Debuff, Enfraquecimento, Restricao e Bencao.
- Definir limites de Selo: duracao, carga, alvo, alcance, condicao e custo de manutencao.
- Definir limites de Cura: grau de ferimento, tempo de uso, custo, falha e proibicao de negar morte/trauma sem ADM.
- Ajustar `capacityService` apenas depois que Suporte estiver balanceada e parcialmente liberada.
- Revisar se Criacao/Reforco devem marcar alguns nos como `requiresApproval` antes de compra ou apenas antes de uso complexo.
- Manter Mana sem refactor grande; focar apenas em custo/aprovacao narrativa dos topos.

## Confirmacoes desta fase

- JSONs ativos nao foram alterados.
- Custos reais nao foram alterados.
- PH nao foi alterado.
- Ledger e compra de no nao foram alterados.
- Compra de Suporte nao foi liberada.
- Renderers e visuais nao foram alterados.
- Capacidade tecnica nao foi alterada.
- `mudzap` nao foi alterado.
- `.#avaliar` nao foi criado.
- Avaliacao automatica nao foi criada.
- PM2 nao foi reiniciado.

