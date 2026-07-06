# Manual de nós, ranks e requisitos narrativos v1

Documento técnico para revisão humana das árvores do Clover RPG.

Este manual é documental. Ele não altera o bot, não altera PH, não altera custos ativos, não altera compra de nó e não libera compra de Suporte.

## Escopo

- Registrar a lógica proposta de ranks, custos sugeridos e requisitos narrativos.
- Cobrir as árvores atuais: Mana, Suporte, Criação e Reforço.
- Usar os JSONs ativos apenas como fonte de nomes, rotas e contagem.
- Registrar divergências sem corrigir runtime nesta fase.

## Estado atual lido do runtime

| Árvore | Nós | Arestas | Observação |
|---|---:|---:|---|
| Mana | 57 | 67 | Visual aprovado e compra ativa conforme regras atuais. |
| Suporte | 21 | 22 | Consultável; compra bloqueada até balanceamento. |
| Criação | 28 | 27 | Visual separado aplicado; compra ativa conforme regras atuais. |
| Reforço | 25 | 24 | Visual separado aplicado; compra ativa conforme regras atuais. |

## Régua de custo proposta

| Custo | Uso sugerido |
|---:|---|
| 15 PH | Nó base, entrada ou acesso inicial simples. |
| 25 PH | Rank I, uso real inicial ou técnica funcional básica. |
| 40 PH | Rank II, uso confiável e geralmente suficiente para liberar filhos. |
| 60 PH | Rank III, domínio técnico, uso forte e refinado. |
| 80 PH | Avançado, gateway forte, técnica perigosa ou ampla. |
| 100+ PH | Topo, proibido, Zona, Maldição, efeito muito forte ou exigência narrativa pesada. |

Contexto de progressão: treino comum gira em torno de 15 PH; limite comum de treino por ciclo/reino fica em 40 PH; missão é extra e pode pagar mais.

## Regra central de ranks

Rank I é acesso bruto e início funcional.

Rank II é uso confiável, domínio intermediário e geralmente libera filhos.

Rank III é maestria, refinamento e uso forte. Ele melhora qualidade, estabilidade, complexidade ou alcance, mas nem sempre precisa ser requisito para avançar.

Regra de revisão: quando um caminho tem Rank I/II/III, Rank II deve ser tratado como o ponto comum de liberação. Rank III vira melhoria forte, não trava universal.

## Requisitos narrativos

| Categoria | Definição |
|---|---|
| Livre | Compra normal por PH, sem cena obrigatória. |
| Treino registrado | Exige treino/cena simples ou justificativa mínima. |
| Marco narrativo | Exige cena importante, mestre, missão, descoberta, prova ou aprovação ADM. |
| Proibido/especial | Exige evento, grimório especial, anomalia, maldição, pacto, pesquisa proibida, permissão direta ou arco específico. |

## Como ler as tabelas

- `Custo sugerido` é proposta para a fase de balanceamento, não custo ativo.
- `Compra agora` descreve o estado atual do bot.
- `ADM` indica sugestão de aprovação narrativa/admin para a revisão futura.
- Nas árvores onde o runtime já separa Rank I/II/III em nós diferentes, a descrição por rank aparece na própria linha do nó.

---

# Árvore: Suporte

## Resumo da árvore

Suporte é a árvore mais sensível. Ela lida com efeitos, condições, bênçãos, pragas, selos, cura, buff, debuff, comunicação, transmissão, interferências mágicas, magia escrita/formulada e magia proibida.

Suporte não é dano bruto e não substitui Criação/Mana. Seu papel é organizar o modo como efeitos são aplicados, condicionados, transmitidos, reforçados, enfraquecidos ou proibidos.

## Definição oficial de Magigramática

Magigramática é o estudo da magia por meio da gramática mágica.

É a área que entende magia como linguagem, fórmula, estrutura, símbolo, regra e condição.

Ela funciona quase como uma matemática da magia: se a mana é energia, a Magigramática é a forma de escrever, organizar, programar e condicionar essa energia.

Ela abre caminho para selos, runas, fórmulas, comunicação mágica, condições, armadilhas, bênçãos, efeitos estruturados, regras mágicas e magia proibida quando levada por caminhos perigosos.

Magigramática não é só suporte genérico. Ela é a base acadêmica e técnica da magia escrita e formulada.

## Divergências registradas do JSON atual

- A referência do briefing coloca `Praga` como consequência de `Debuff`; o JSON atual coloca `Praga` como rota direta de `Suporte`.
- A referência coloca `Benção` dentro do tronco de `Magigramática`; o JSON atual coloca `Benção` como rota direta de `Suporte`.
- A referência coloca `Comunicação`, `Junção de Forma` e `Armadilha` abaixo de `Selo`; o JSON atual liga `Comunicação` e `Junção de Forma` diretamente em `Magigramática`, e `Armadilha` vem depois de `Transformação`.
- Nenhuma dessas divergências foi corrigida nesta fase.

## Tabela de nós

| Nó | Tipo | Rank máximo | Custo sugerido | Libera filhos em | Requisito mecânico | Requisito narrativo | Compra agora | ADM | Descrição e limite |
|---|---|---|---|---|---|---|---|---|---|
| Suporte | base | único | 15 | único | nenhum | Livre | não, bloqueada | não | Base para efeitos que alteram, protegem, curam, enfraquecem ou interferem. Não dá dano bruto nem manifestação direta. |
| Magigramática | rota/técnica | III | 25/40/60 | Rank II | Suporte | Livre I; Treino II; Marco III | não, bloqueada | III | Gramática mágica: símbolos, fórmulas, regras e condições. Não cria qualquer efeito sem atributo compatível. |
| Praga | técnica perigosa | III | 25/40/60 ou 80+ | Rank I com marco | Suporte | Marco I; Proibido II/III | não, bloqueada | sim | Debuff persistente, contaminante, simbólico ou progressivo. Não deve ser praga livre sem consequência. |
| Benção | técnica | III | 25/40/60 | Rank II | Suporte | Livre I; Treino II; Marco III | não, bloqueada | III | Efeito positivo em si, aliado, objeto ou condição. Não anula custo, ferida ou consequência sozinha. |
| Selo | técnica | III | 25/40/60 | Rank II | Magigramática | Treino I; Marco II/III | não, bloqueada | II/III | Marca ou estrutura fixa para armazenar, condicionar, travar, ativar ou organizar efeitos. |
| Comunicação | técnica | III | 25/40/60 | Rank II | Magigramática | Livre I; Treino II; Marco III | não, bloqueada | III | Transmite mensagem, sinal, voz, marca ou informação. Não vira telepatia absoluta sem limite. |
| Junção de Forma | gateway | único | 80 | único | Magigramática | Marco narrativo | não, bloqueada | sim | Integra suporte a forma, objeto, área, selo ou manifestação. Não é compra trivial. |
| Transformação | técnica | III | 25/40/60 | Rank II | Comunicação | Treino I/II; Marco III | não, bloqueada | III | Altera estado, forma, aparência ou propriedade dentro do atributo mágico. Não transmuta qualquer coisa sem base. |
| Armadilha | técnica | III | 25/40/60 | Rank II | Transformação | Treino I; Marco II/III | não, bloqueada | sim | Efeito preparado para ativar quando condição ocorre. Não deve criar gatilho perfeito sem leitura narrativa. |
| Condição | técnica | III | 25/40/60 | Rank II | Armadilha | Treino I; Marco II/III | não, bloqueada | sim | Regra que define quando, como ou contra quem um efeito funciona. Não cria contrato absoluto sozinho. |
| M. Proibida | proibido/gateway | único | 100+ | único | Condição + Praga | Proibido/especial | não, bloqueada | sim | Porta para práticas perigosas, impuras ou restritas. Exige marco, evento, pacto, anomalia ou permissão direta. |
| Maldição | proibido | único | 100+ | único | M. Proibida | Proibido/especial | não, bloqueada | sim | Efeito nocivo persistente, espiritual, corporal ou mágico. Não liberar como compra comum. |
| Ilusão | técnica sensível | III | 25/40/60 | Rank II | M. Proibida | Livre/Treino I; Marco II/III | não, bloqueada | sim | Manipula percepção, aparência ou sensação. Não controla mente de forma total sem arco. |
| Absorção | técnica sensível | III | 25/40/60 ou 80+ | Rank II | M. Proibida | Marco I; Proibido II/III | não, bloqueada | sim | Puxa, drena, redireciona ou consome energia/efeito em limite definido. Não rouba mana sem limite. |
| Enfraquecimento | técnica | III | 25/40/60 | Rank II | Ilusão | Treino I/II; Marco III | não, bloqueada | sim | Reduz força, eficiência, estabilidade ou potência. Não anula personagem inteiro. |
| Restrição | técnica sensível | III | 25/40/60 | Rank II | Absorção | Marco narrativo | não, bloqueada | sim | Limita movimento, ação, magia, alcance ou ativação. Não paralisa totalmente sem permissão. |
| Debuff | técnica | III | 25/40/60 | Rank II | Enfraquecimento + Restrição | Livre I; Treino II; Marco III | não, bloqueada | sim | Redução mecânica/situacional aplicada a alvo, técnica ou condição. Não substitui Praga ou Maldição. |
| Efeito | técnica | III | 25/40/60 | Rank II | Cura | Livre I; Treino II; Marco III | não, bloqueada | III | Base ampla para efeitos estruturados não cobertos por buff/debuff/cura. Não resolve tudo sozinho. |
| Cura | técnica sensível | III | 25/40/60 | Rank II | Benção | Treino I; Marco II/III | não, bloqueada | sim | Recupera dano, condição, desgaste ou ferimento dentro do atributo. Não nega morte ou trauma grave sem ADM. |
| Transmissão | técnica | III | 25/40/60 | Rank II | Buff | Treino I/II; Marco III | não, bloqueada | III | Envia efeito, sinal, energia ou função por vínculo, marca, selo ou distância. Não cria rede ilimitada. |
| Buff | técnica | III | 25/40/60 | Rank II | Benção | Livre I; Treino II; Marco III | não, bloqueada | III | Melhoria temporária de atributo, proteção, eficiência ou técnica. Não acumula sem regra de cena. |

## Descrições por rank para Suporte

Magigramática I entende símbolos simples e fórmulas básicas. Magigramática II monta fórmulas funcionais e libera caminhos de selo, comunicação, bênção e condições simples. Magigramática III domina fórmulas compostas e regras condicionais refinadas.

Selo I cria selos simples e diretos. Selo II aceita condição, duração melhor ou função mais estável. Selo III cria selos complexos, compostos ou duradouros, geralmente com aprovação.

Comunicação I manda mensagem curta ou sinal simples. Comunicação II amplia estabilidade, distância ou condição. Comunicação III permite rede, codificação ou longo alcance.

Armadilha I tem ativação direta. Armadilha II tem condição melhor e efeito mais estável. Armadilha III pode ser seletiva ou ter múltiplas etapas.

Condição I é regra simples. Condição II é regra específica ou seletiva. Condição III é regra composta/refinada.

Transformação I altera levemente. Transformação II altera de forma funcional/estável. Transformação III altera de forma complexa ou duradoura.

Ilusão I é curta e simples. Ilusão II fica mais convincente ou condicionada. Ilusão III é sustentada, seletiva ou difícil de romper.

Absorção I é pequena/situacional. Absorção II fica útil, mas limitada. Absorção III é forte e sempre controlada pela ADM.

Enfraquecimento I é leve. Enfraquecimento II é confiável. Enfraquecimento III é forte, seletivo ou sustentado.

Restrição I limita algo simples. Restrição II fica estável e específica. Restrição III é forte/complexa e exige cuidado.

Debuff I é leve. Debuff II é moderado. Debuff III é forte ou sustentado.

Praga I é limitada e reversível. Praga II é persistente e exige justificativa forte. Praga III é grave, rara e controlada pela ADM.

Benção I é simples. Benção II é confiável, duradoura ou condicionada. Benção III é forte, seletiva ou de impacto amplo.

Cura I é leve. Cura II é moderada. Cura III é forte, mas não nega morte, trauma grave ou consequência sem aprovação.

Efeito I é função simples. Efeito II adiciona condição ou duração melhor. Efeito III é composto, refinado ou de maior alcance.

Buff I é leve. Buff II é moderado/confiável. Buff III é forte, sustentado ou seletivo.

Transmissão I é simples/curta. Transmissão II é estável ou distante. Transmissão III é complexa, seletiva ou com múltiplos destinos.

---

# Árvore: Criação

## Resumo da árvore

Criação é manifestação mágica. Ela permite criar formas simples desde o início, mas refinamento vem por rotas.

Criação não buffa o corpo. Criação melhora a manifestação criada.

## Tabela de nós

| Nó | Tipo | Rank máximo | Custo sugerido | Libera filhos em | Requisito mecânico | Requisito narrativo | Compra agora | ADM | Descrição e limite |
|---|---|---|---|---|---|---|---|---|---|
| Criação | base | único | 15 | único | nenhum | Livre | sim | não | Permite formas simples: esfera, lâmina, névoa pequena, bloco, fio, projétil pequeno ou barreira simples. |
| Controle | gateway | único | 15/25 | único | Criação | Livre | sim | não | Move, guia, estabiliza e ajusta manifestação criada. |
| Defesa Mágica I | upgrade | série III | 25 | Rank II libera confiança | Controle | Livre | sim | não | + defesa básica da criação. Não protege corpo sem criação/forma. |
| Defesa Mágica II | upgrade | série III | 40 | sim | Defesa I | Treino registrado | sim | não | Defesa mais confiável da criação. |
| Defesa Mágica III | upgrade | série III | 60 | melhoria | Defesa II | Treino/Marco | sim | sugerido | Defesa refinada/forte da criação. |
| Velocidade Mágica I | upgrade | série III | 25 | Rank II libera confiança | Controle | Livre | sim | não | Aumenta velocidade da manifestação. |
| Velocidade Mágica II | upgrade | série III | 40 | sim | Velocidade I | Treino registrado | sim | não | Movimento mais confiável. |
| Velocidade Mágica III | upgrade | série III | 60 | melhoria | Velocidade II | Treino/Marco | sim | sugerido | Velocidade refinada/forte. |
| Força Mágica I | upgrade | série III | 25 | Rank II libera confiança | Controle | Livre | sim | não | Aumenta impacto da manifestação. |
| Força Mágica II | upgrade | série III | 40 | sim | Força I | Treino registrado | sim | não | Impacto mais confiável. |
| Força Mágica III | upgrade | série III | 60 | melhoria | Força II | Treino/Marco | sim | sugerido | Impacto refinado/forte. |
| Estrutura | gateway | único | 15/25 | único | Criação | Livre | sim | não | Deixa a forma menos frágil e mais estável. |
| Densidade I | upgrade | série III | 25 | Rank II libera confiança | Estrutura | Livre | sim | não | Criação mais compacta, sólida ou resistente. |
| Densidade II | upgrade | série III | 40 | sim | Densidade I | Treino registrado | sim | não | Densidade confiável. |
| Densidade III | upgrade | série III | 60 | melhoria | Densidade II | Treino/Marco | sim | sugerido | Densidade forte/refinada. |
| Precisão I | upgrade | série III | 25 | Rank II libera confiança | Estrutura | Livre | sim | não | Forma mais exata, fina ou cirúrgica. |
| Precisão II | upgrade | série III | 40 | sim | Precisão I | Treino registrado | sim | não | Precisão confiável. |
| Precisão III | upgrade | série III | 60 | melhoria | Precisão II | Treino/Marco | sim | sugerido | Precisão refinada/forte. |
| Junção de Forma | gateway | único | 80 | único | Criação | Marco se complexo | sim | sugerido | Combina formas ou funções. Não precisa para espada simples. |
| Armas | técnica | série III | 25 | Rank II libera confiança | Junção | Livre/Treino | sim | não | Especialização em manifestações armadas; não é obrigatório para arma simples. |
| Armas II | técnica | série III | 40 | sim | Armas | Treino registrado | sim | não | Armas mágicas mais focadas. |
| Armas III | técnica | série III | 60/80 | melhoria | Armas II | Marco narrativo | sim | sugerido | Manifestações armadas avançadas. |
| Formas Humanoides | técnica | série III | 25 | Rank II libera confiança | Junção | Treino registrado | sim | sugerido | Corpos, membros, bonecos, avatares e construtos humanoides. |
| Formas Humanoides II | técnica | série III | 40/60 | sim | Formas I | Marco narrativo | sim | sugerido | Formas corporais mais estáveis. |
| Formas Humanoides III | técnica | série III | 60/80 | melhoria | Formas II | Marco narrativo | sim | sim | Forma humanoide avançada. |
| Ambiente | técnica | série III | 25 | Rank II libera confiança | Junção | Treino registrado | sim | sugerido | Área pequena, névoa, campo ou terreno alterado. Não precisa para névoa simples. |
| Ambiente II | técnica | série III | 40/60 | sim | Ambiente | Marco narrativo | sim | sugerido | Área/campo mais estável. |
| Ambiente III | técnica | série III | 60/80 | melhoria | Ambiente II | Marco narrativo | sim | sim | Ambiente amplo ou perigoso. |

## Pendências de Criação

- Revisar se gateways `Controle` e `Estrutura` devem cair para 15 PH na Fase 8B.
- Avaliar se `Junção de Forma` deve exigir marco antes da compra ou só antes de uso complexo.
- Manter claro que Criação melhora manifestação criada, não corpo físico.

---

# Árvore: Reforço

## Resumo da árvore

Reforço é buff mágico no corpo, atributos físicos ou aliados.

Reforço não buffa projétil/criação mágica comum. Isso é função de Criação.

## Tabela de nós

| Nó | Tipo | Rank máximo | Custo sugerido | Libera filhos em | Requisito mecânico | Requisito narrativo | Compra agora | ADM | Descrição e limite |
|---|---|---|---|---|---|---|---|---|---|
| Reforço | base | único | 15 | único | nenhum | Livre | sim | não | Fortalecimento corporal básico com limite inicial baixo. |
| Intensidade I | upgrade | série III | 25 | Rank II libera confiança | Reforço | Livre | sim | não | Define buff em torno de +10%. |
| Intensidade II | upgrade | série III | 40 | sim | Intensidade I | Treino registrado | sim | não | Define buff em torno de +20%. |
| Intensidade III | upgrade | série III | 60 | melhoria | Intensidade II | Treino/Marco | sim | sugerido | Define buff em torno de +30%. |
| Estabilidade I | upgrade | série III | 25 | Rank II libera confiança | Reforço | Livre | sim | não | Duração, segurança e menor desgaste. |
| Estabilidade II | upgrade | série III | 40 | sim | Estabilidade I | Treino registrado | sim | não | Estabilidade confiável. |
| Estabilidade III | upgrade | série III | 60 | melhoria | Estabilidade II | Treino/Marco | sim | sugerido | Estabilidade forte/refinada. |
| Foco de Atributo | gateway | escada | 25 | único | Reforço | Livre | sim | não | Permite definir atributo do reforço; sem foco extra, 1 atributo. |
| Duplo Foco | upgrade | escada | 40 | sim | Foco | Treino registrado | sim | não | Permite 2 atributos no mesmo reforço. |
| Múltiplo Foco | upgrade | escada | 60 | melhoria | Duplo Foco | Marco narrativo | sim | sugerido | Permite até 3 atributos no mesmo reforço. |
| Invencível | gateway | único | 25 | único | Reforço | Livre/Treino | sim | não | Rota de autobuff. |
| Força Reforçada | permissão | único | 25 | único | Invencível | Livre | sim | não | Permite reforçar Força. A potência vem de Intensidade/Estabilidade. |
| Velocidade Reforçada | permissão | único | 25 | único | Invencível | Livre | sim | não | Permite reforçar Velocidade. |
| Agilidade Reforçada | permissão | único | 25 | único | Invencível | Livre | sim | não | Permite reforçar Agilidade. |
| Resistência Reforçada | permissão | único | 25 | único | Invencível | Livre | sim | não | Permite reforçar Resistência. |
| Defesa Reforçada | permissão | único | 25 | único | Invencível | Livre | sim | não | Permite reforçar Defesa corporal. |
| Invicto | gateway | único | 40/80 | único | Reforço | Marco narrativo | sim | sugerido | Rota de buff em outros; conversa com Benção/Suporte no futuro. |
| Reforço por Toque | técnica | escada | 25/40 | único | Invicto | Treino registrado | sim | sugerido | Buff externo por toque. |
| Reforço à Distância | técnica | escada | 60/80 | único | Toque | Marco narrativo | sim | sugerido | Buff sem tocar, limitado por Alcance/Controle/Emissão. |
| Reforço Coletivo | avançado | escada | 80/100 | único | Distância | Marco narrativo | sim | sim | Buff em mais de um alvo. Não deve ser amplo sem custo. |
| Junção de Forma | gateway | único | 80 | único | Reforço | Marco se complexo | sim | sugerido | Liga reforço com forma, área, armadura, aura, arma ou campo. |
| Reforço Avançado | avançado | único | 80 | único | Junção | Marco narrativo | sim | sugerido | Mistura reforço com armadura, área, aura, arma ou campo. |
| Reforço Avançado: Armas | avançado | único | 80 | único | Reforço Avançado | Marco narrativo | sim | sugerido | Reforço ligado a armas ou estilo armado. |
| Reforço Avançado: Formas Humanoides | avançado | único | 80/100 | único | Reforço Avançado | Marco narrativo | sim | sim | Armadura, exoesqueleto, avatar ou corpo mágico. |
| Reforço Avançado: Ambiente | avançado | único | 100+ | único | Reforço Avançado | Marco narrativo | sim | sim | Reforço aplicado em área/campo. |

## Pendências de Reforço

- Não criar I/II/III para cada atributo reforçado agora.
- A força do buff deve vir de Intensidade, Estabilidade, Foco, Hexágono e contexto.
- Revisar se Invicto deve ser gateway narrativo antes de compra ou apenas antes de uso real em aliados.

---

# Árvore: Mana

## Resumo da árvore

Mana é técnica de manipulação de energia mágica. A árvore libera técnica; o Hexágono define limite prático.

Pesos já combinados que não devem ser alterados nesta fase:

- Bala de Mana I/II/III: Peso 2/4/6.
- Pulso de Mana I/II/III: Peso 2/4/6.
- Pele de Mana ativa: Peso 2.
- Manto de Mana: Peso 5.

## Tabela de nós

| Nó | Tipo | Rank máximo | Custo sugerido | Libera filhos em | Requisito mecânico | Requisito narrativo | Compra agora | ADM | Descrição e limite |
|---|---|---|---|---|---|---|---|---|---|
| MANA | base | único | 15 | único | nenhum | Livre | sim | não | Base da manipulação de mana. Não é tipo de magia. |
| Percepção de Mana | rota | único | 15/25 | único | MANA | Livre | sim | não | Abre leitura de fluxo e presença mágica. |
| Fluxo de Mana | rota | único | 15/25 | único | MANA | Livre | sim | não | Abre circulação, estabilidade e condução. |
| Retenção de Mana | rota | único | 15/25 | único | MANA | Livre | sim | não | Abre economia, recuperação e sustentação. |
| Emissão de Mana | rota | único | 15/25 | único | MANA | Livre | sim | não | Abre projeção de mana pura. |
| Sentir Mana I | técnica | série III | 25 | Rank II | Percepção | Livre | sim | não | Percepção inicial de presença e fluxo. |
| Sentir Mana II | técnica | série III | 40 | sim | Sentir I | Treino registrado | sim | não | Leitura confiável de presença e fluxo. |
| Sentir Mana III | técnica | série III | 60 | melhoria | Sentir II | Treino/Marco | sim | sugerido | Leitura refinada/intensa. |
| Leitura de Flutuação | técnica | único | 40 | único | Sentir II | Treino registrado | sim | não | Lê alterações e oscilações de mana. |
| Assinatura Mágica | técnica | único | 40/60 | único | Sentir II | Treino/Marco | sim | sugerido | Reconhece assinatura de mana. Não identifica tudo sem referência. |
| Campo de Mana I | técnica | série III | 25 | Rank II | Percepção + Fluxo | Treino | sim | não | Campo perceptivo simples. |
| Campo de Mana II | técnica | série III | 40 | sim | Campo I | Treino | sim | não | Campo mais estável. |
| Campo de Mana III | técnica | série III | 60 | melhoria | Campo II | Marco | sim | sugerido | Campo amplo/refinado. |
| Circulação | técnica | único | 25 | único | Fluxo | Livre | sim | não | Circula mana pelo corpo. |
| Estabilidade | técnica | único | 40 | único | Circulação | Treino | sim | não | Reduz oscilação do fluxo. |
| Canalização | técnica | único | 40 | único | Estabilidade | Treino | sim | não | Direciona mana para uso técnico. |
| Ritmo de Mana | técnica | único | 40 | único | Circulação | Treino | sim | não | Ajusta ritmo e resposta do fluxo. |
| Pele de Mana I | técnica | série III | 25 | Rank II | Fluxo + Retenção | Treino | sim | não | Revestimento defensivo simples. |
| Pele de Mana II | técnica | série III | 40 | sim | Pele I | Treino | sim | não | Revestimento confiável. |
| Pele de Mana III | técnica | série III | 60 | melhoria | Pele II | Marco | sim | sugerido | Revestimento refinado. |
| Manto de Mana | técnica avançada | único | 80 | único | Pele II/III | Marco | sim | sugerido | Manto ativo de mana. Peso 5. |
| Controle Fino I | técnica | série III | 25 | Rank II | Fluxo | Treino | sim | não | Ajuste fino inicial. |
| Controle Fino II | técnica | série III | 40 | sim | Controle I | Treino | sim | não | Ajuste confiável. |
| Controle Fino III | técnica | série III | 60 | melhoria | Controle II | Marco | sim | sugerido | Ajuste refinado. |
| Compressão de Mana | técnica avançada | único | 80 | único | Controle Fino | Marco | sim | sugerido | Compacta mana. Não aumenta poder sem custo/limite. |
| Voo de Vassoura | técnica | único | 40/60 | único | Fluxo | Treino | sim | não | Voo por objeto/apoio. |
| Revestimento de Objeto | técnica | único | 40/60 | único | Fluxo | Treino | sim | não | Reveste objeto com mana. |
| Manutenção Simultânea | avançado | único | 80/100 | único | Controle + Retenção | Marco | sim | sugerido | Mantém mais de um efeito. Não ignora manutenção. |
| Economia I | técnica | série III | 25 | Rank II | Retenção | Livre/Treino | sim | não | Reduz desperdício levemente. |
| Economia II | técnica | série III | 40 | sim | Economia I | Treino | sim | não | Economia confiável. |
| Economia III | técnica | série III | 60 | melhoria | Economia II | Marco | sim | sugerido | Economia refinada. |
| Recuperação I | técnica | série III | 25 | Rank II | Retenção | Livre/Treino | sim | não | Recuperação leve. |
| Recuperação II | técnica | série III | 40 | sim | Recuperação I | Treino | sim | não | Recuperação confiável. |
| Recuperação III | técnica | série III | 60 | melhoria | Recuperação II | Marco | sim | sugerido | Recuperação refinada. |
| Ocultação de Mana | técnica | único | 60/80 | único | Retenção + Controle | Marco | sim | sugerido | Oculta presença. Não torna indetectável contra tudo. |
| Núcleo de Mana | avançado | único | 80 | único | Retenção | Marco | sim | sugerido | Organiza reserva/centro técnico de mana. |
| Leitura Ambiental | técnica | único | 60/80 | único | Percepção | Treino/Marco | sim | sugerido | Lê mana do ambiente. |
| Adaptação Ambiental | técnica | único | 80 | único | Leitura Ambiental | Marco | sim | sugerido | Ajusta uso ao ambiente. |
| Mana Ambiente I | técnica | série III | 80 | Rank II | Leitura + Fluxo | Marco | sim | sugerido | Uso inicial de mana ambiental. |
| Mana Ambiente II | técnica | série III | 100 | sim | Mana Ambiente I | Marco | sim | sim | Uso confiável de mana ambiental. |
| Mana Ambiente III | técnica | série III | 100+ | melhoria | Mana Ambiente II | Marco forte | sim | sim | Uso refinado/forte de mana ambiental. |
| Ressonância | técnica avançada | único | 80/100 | único | Mana Ambiente | Marco | sim | sugerido | Ressonância com fluxo externo. |
| Método de Mana | gateway avançado | único | 100+ | único | Mana Ambiente/Ressonância | Marco forte | sim | sim | Método pessoal/técnico de uso de mana. |
| Bala de Mana I | técnica | série III | 25 | Rank II | Emissão | Livre/Treino | sim | não | Projétil puro simples. Peso 2. |
| Bala de Mana II | técnica | série III | 40 | sim | Bala I | Treino | sim | não | Projétil confiável. Peso 4. |
| Bala de Mana III | técnica | série III | 60 | melhoria | Bala II | Marco | sim | sugerido | Projétil forte/refinado. Peso 6. |
| Pulso de Mana I | técnica | série III | 25 | Rank II | Emissão + Percepção | Treino | sim | não | Onda/pulso simples. Peso 2. |
| Pulso de Mana II | técnica | série III | 40 | sim | Pulso I | Treino | sim | não | Pulso confiável. Peso 4. |
| Pulso de Mana III | técnica | série III | 60 | melhoria | Pulso II | Marco | sim | sugerido | Pulso forte/refinado. Peso 6. |
| Pressão de Mana | técnica avançada | único | 80 | único | Emissão | Marco | sim | sugerido | Pressão/disputa de mana. Não vence tudo sem atributo. |
| Condutor | gateway | único | 80/100 | único | múltiplas rotas | Marco | sim | sugerido | Papel de condução superior de mana. |
| Reservatório | gateway | único | 80/100 | único | múltiplas rotas | Marco | sim | sugerido | Papel de reserva/sustentação superior. |
| Dominador | gateway topo | único | 100+ | único | múltiplas rotas | Marco forte | sim | sim | Domínio técnico superior de mana. |
| Zona de Mana I | proibido/topo | série III | 100+ | Rank II | Mana Ambiente + Marco | Proibido/especial | aprovação | sim | Primeira abertura de Zona de Mana. |
| Zona de Mana II | proibido/topo | série III | 100+ | sim | Zona I | Proibido/especial | aprovação | sim | Zona confiável. |
| Zona de Mana III | proibido/topo | série III | 100+ | melhoria | Zona II | Proibido/especial | aprovação | sim | Zona refinada/forte. |
| Domínio de Mana | topo | único | 100+ | único | Zona/Maestria | Proibido/especial | aprovação | sim | Domínio final. Não deve ser compra comum sem arco. |

## Pendências de Mana

- Registrar com a ADM quais nós de Maestria devem virar marco narrativo obrigatório antes da compra.
- Não alterar pesos de Bala, Pulso, Pele ou Manto nesta fase.
- Manter Hexágono como limite prático.

---

# Nós rankados por árvore

## Suporte

Magigramática, Selo, Comunicação, Armadilha, Condição, Ilusão, Absorção, Enfraquecimento, Restrição, Debuff, Praga, Benção, Cura, Buff, Transmissão, Efeito e Transformação.

Gateways/especiais: Suporte, M. Proibida, Maldição e Junção de Forma.

## Criação

Defesa Mágica, Velocidade Mágica, Força Mágica, Densidade, Precisão, Armas, Formas Humanoides e Ambiente.

Gateways: Criação, Controle, Estrutura e Junção de Forma.

## Reforço

Rankados: Intensidade e Estabilidade.

Escadas: Foco de Atributo -> Duplo Foco -> Múltiplo Foco; Reforço por Toque -> Reforço à Distância -> Reforço Coletivo.

Permissões: Força Reforçada, Velocidade Reforçada, Agilidade Reforçada, Resistência Reforçada e Defesa Reforçada.

## Mana

Sentir Mana, Campo de Mana, Pele de Mana, Controle Fino, Economia, Recuperação, Bala de Mana, Pulso de Mana, Mana Ambiente e Zona de Mana.

Gateways/especiais: Condutor, Reservatório, Dominador, Método de Mana e Domínio de Mana.

# Pontos pendentes para revisão humana

- Definir se o JSON de Suporte deve ser reorganizado para bater com a árvore textual do briefing.
- Decidir se Suporte terá nós rankados como nós separados no runtime ou se um nó único guardará ranks internos.
- Definir o custo final da régua 15/25/40/60/80/100+ antes de tocar nos JSONs ativos.
- Decidir quais nós de Criação/Reforço continuam compra livre e quais viram aprovação narrativa.
- Confirmar se `capacityService.js` deve incluir Suporte futuramente; hoje ele lê apenas Mana, Criação e Reforço.
- Confirmar se `requiresApproval` atual deve ser mantido ou recalculado na Fase 8B.
- Criar textos finais player-facing para `.#no suporte <no>` depois do balanceamento.

# Confirmações desta fase

- JSONs ativos não foram alterados.
- Custos reais não foram alterados.
- PH, ledger e compra de nó não foram alterados.
- Compra de Suporte continua bloqueada.
- Renderers e visuais não foram alterados.
- Capacidade técnica não foi alterada.
- `mudzap` não faz parte desta documentação.
- `.#avaliar` e avaliação automática não foram criados.
