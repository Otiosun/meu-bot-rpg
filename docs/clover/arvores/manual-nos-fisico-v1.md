# Manual de Nós - Árvore Física v1

Documento interno da Árvore física nova do Clover RPG. Ele registra a Árvore data-driven usada em `data/clover/trees/fisico.json` e o visual oficial em `helpers/clover/approvedVisuals/fisico_tree_v8.html`.

## Escopo

- Árvore física pura: corpo, vigor, controle corporal, leitura, instinto, Contra Magos, Ki e Zetten.
- Não inclui Estilo de Luta, armas específicas, golpes personalizados ou avaliação automática.
- Físico não depende do Hexágono de Mana.
- Nós de topo com `requiresApproval` precisam de cena, treino, marco e decisão da ADM.

## Resumo

- Nós: 71.
- Rotas: 8.
- Nós com aprovação narrativa: ki, ki_ii, ki_iii, zetten, zetten_ii, zetten_iii, apice_fisico.
- Ápice Físico foi registrado como nó real final para manter o nodeCount do HTML aprovado e exibir status visual.

## Rotas

| Rota | Função | Leva a |
|---|---|---|
| Físico | Raiz da progressão física pura. | corpo, vigor, controle corporal |
| Vigor | Corpo bruto, fôlego, desgaste e sustentação. | força, resistência, recuperação |
| Controle Corporal | Movimento, coordenação, precisão e leitura física. | velocidade, agilidade, precisão, percepção |
| Sentidos | Leitura física refinada por visão, audição, olfato, tato e sensação corporal. | sentidos aguçados, especialidades sensoriais |
| Bárbaro | Pressão física, brutalidade corporal e imposição de presença. | tirano, benevolente |
| Culto | Técnica, leitura, eficiência e disciplina corporal. | justo, injusto |
| Contra Magos | Leitura e punição física contra conjuradores. Não é antimagia. | leitura de conjuração, ponto cego, punição de abertura |
| Ki e Zetten | Topo físico de leitura, presença, intenção, timing e execução extrema. | ki, zetten, Ápice físico |

## Nós

| Nó | Rota | Custo | Requisitos | Aprovação | Risco | Peso | Descrição |
|---|---|---:|---|---|---|---:|---|
| Físico | Físico | 15 | livre | não | baixo | 1 | Raiz da progressão física pura. |
| Vigor | Vigor | 15 | Físico | não | baixo | 1 | Abre corpo bruto, fôlego, desgaste e sustentação. |
| Controle Corporal | Controle Corporal | 15 | Físico | não | baixo | 1 | Abre movimento, coordenação, precisão e leitura física. |
| Força | Vigor | 15 | Vigor | não | baixo | 1 | Potência corporal geral. |
| Resistência | Vigor | 15 | Vigor | não | baixo | 1 | Aguentar dano, pressão e fadiga. |
| Recuperação | Vigor | 15 | Vigor | não | baixo | 1 | Reequilíbrio físico e retorno ao ritmo. |
| Velocidade | Controle Corporal | 15 | Controle Corporal | não | baixo | 1 | Deslocamento bruto. |
| Agilidade | Controle Corporal | 15 | Controle Corporal | não | baixo | 1 | Adaptação do corpo em movimento. |
| Precisão | Controle Corporal | 15 | Controle Corporal | não | baixo | 1 | Colocar o corpo e o golpe exatamente onde deve. |
| Percepção | Controle Corporal | 15 | Controle Corporal | não | baixo | 1 | Leitura do mundo físico, do corpo e do movimento. |
| Impacto | Vigor | 25 | Força | não | baixo | 2 | Golpes pesados, quebra de guarda e força aplicada diretamente. |
| Impacto II | Vigor | 40 | Impacto | não | médio | 3 | Impacto mais confiável e pesado. |
| Impacto III | Vigor | 60 | Impacto II | não | médio | 4 | Impacto avançado para pressão física alta. |
| Explosão Muscular | Vigor | 25 | Força | não | baixo | 2 | Picos curtos de potência e aceleração muscular. |
| Explosão II | Vigor | 40 | Explosão Muscular | não | médio | 3 | Explosão muscular mais controlada. |
| Explosão III | Vigor | 60 | Explosão II | não | médio | 4 | Explosão muscular avançada. |
| Corpo Firme | Vigor | 25 | Resistência | não | baixo | 2 | Estabilidade, firmeza e sustentação sob impacto. |
| Corpo Firme II | Vigor | 40 | Corpo Firme | não | médio | 3 | Firmeza física mais confiável. |
| Corpo Firme III | Vigor | 60 | Corpo Firme II | não | médio | 4 | Corpo firme avançado. |
| Tolerância à Dor | Vigor | 25 | Resistência | não | baixo | 2 | Continuar funcional mesmo ferido. |
| Tolerância II | Vigor | 40 | Tolerância à Dor | não | médio | 3 | Tolerância mais confiável. |
| Tolerância III | Vigor | 60 | Tolerância II | não | médio | 4 | Tolerância avançada. |
| Fôlego | Vigor | 25 | Recuperação | não | baixo | 2 | Sustentação respiratória e tempo de esforço. |
| Ritmo Respiratório | Vigor | 25 | Fôlego | não | baixo | 2 | Manter constância e controle do próprio ritmo. |
| Ritmo II | Vigor | 40 | Ritmo Respiratório | não | médio | 3 | Ritmo respiratório mais confiável. |
| Ritmo III | Vigor | 60 | Ritmo II | não | médio | 4 | Ritmo respiratório avançado. |
| Retomada Física | Vigor | 25 | Fôlego | não | baixo | 2 | Recuperar o corpo depois de esforço, tranco ou queda de ritmo. |
| Retomada II | Vigor | 40 | Retomada Física | não | médio | 3 | Retomada física mais confiável. |
| Retomada III | Vigor | 60 | Retomada II | não | médio | 4 | Retomada física avançada. |
| Arranque | Controle Corporal | 25 | Velocidade | não | baixo | 2 | Aceleração inicial. |
| Arranque II | Controle Corporal | 40 | Arranque | não | médio | 3 | Arranque mais confiável. |
| Arranque III | Controle Corporal | 60 | Arranque II | não | médio | 4 | Arranque avançado. |
| Deslocamento | Controle Corporal | 25 | Velocidade | não | baixo | 2 | Movimentação útil em combate. |
| Deslocamento II | Controle Corporal | 40 | Deslocamento | não | médio | 3 | Deslocamento mais confiável. |
| Deslocamento III | Controle Corporal | 60 | Deslocamento II | não | médio | 4 | Deslocamento avançado. |
| Reação Corporal | Controle Corporal | 25 | Agilidade | não | baixo | 2 | Resposta física rápida. |
| Reação II | Controle Corporal | 40 | Reação Corporal | não | médio | 3 | Reação física mais confiável. |
| Reação III | Controle Corporal | 60 | Reação II | não | médio | 4 | Reação corporal avançada. |
| Mudança de Direção | Controle Corporal | 25 | Agilidade | não | baixo | 2 | Virar, cortar caminho e reajustar o corpo sem perder tudo. |
| Mudança II | Controle Corporal | 40 | Mudança de Direção | não | médio | 3 | Mudança de direção mais confiável. |
| Mudança III | Controle Corporal | 60 | Mudança II | não | médio | 4 | Mudança de direção avançada. |
| Ponto Fraco | Controle Corporal | 25 | Precisão | não | baixo | 2 | Identificar e explorar aberturas físicas. |
| Ponto Fraco II | Controle Corporal | 40 | Ponto Fraco | não | médio | 3 | Leitura de abertura mais confiável. |
| Ponto Fraco III | Controle Corporal | 60 | Ponto Fraco II | não | médio | 4 | Leitura avançada de aberturas físicas. |
| Sentidos | Sentidos | 25 | Percepção | não | baixo | 2 | Percepção física geral. |
| Sentidos Aguçados | Sentidos | 40 | Sentidos | não | médio | 3 | Sentidos refinados e mais úteis em combate. |
| Sentidos III | Sentidos | 60 | Sentidos Aguçados | não | médio | 4 | Leitura sensorial avançada. |
| Visão | Sentidos | 25 | Sentidos Aguçados | não | baixo | 2 | Leitura visual. |
| Audição | Sentidos | 25 | Sentidos Aguçados | não | baixo | 2 | Leitura por som. |
| Olfato | Sentidos | 25 | Sentidos Aguçados | não | baixo | 2 | Leitura por cheiro e presença. |
| Tato | Sentidos | 25 | Sentidos Aguçados | não | baixo | 2 | Leitura por toque, vibração, pressão, contato e base física. |
| Intuição Corporal Sensorial | Sentidos | 25 | Sentidos Aguçados | não | baixo | 2 | Sensação corporal fina: o corpo entende antes. |
| Intuição Corporal | Controle Corporal | 80 | Ritmo III, Arranque III, Deslocamento III, Reação III, Ponto Fraco III, Sentidos III | não | alto | 5 | Consolida leitura do corpo próprio e do movimento externo. |
| Instinto | Controle Corporal | 100 | Intuição Corporal | não | alto | 5 | Reação quase automática, antes do pensamento terminar. |
| Bárbaro | Bárbaro | 80 | Impacto III, Corpo Firme III, Tolerância III, Retomada III | não | alto | 5 | Rota de pressão física e brutalidade corporal. |
| Tirano | Bárbaro | 100 | Bárbaro | não | alto | 5 | Expressão ofensiva e opressiva do Bárbaro. |
| Benevolente | Bárbaro | 100 | Bárbaro | não | alto | 5 | Expressão defensiva e protetora do Bárbaro. |
| Culto | Culto | 80 | Deslocamento III, Ponto Fraco III, Sentidos III | não | alto | 5 | Rota de técnica, leitura, eficiência e disciplina corporal. |
| Justo | Culto | 100 | Culto | não | alto | 5 | Expressão limpa, técnica e reta do Culto. |
| Injusto | Culto | 100 | Culto | não | alto | 5 | Expressão oportunista, suja e fora do padrão do Culto. |
| Contra Magos | Contra Magos | 80 | Culto, Ponto Fraco III, Deslocamento III, Sentidos III | não | alto | 5 | Leitura e punição física contra conjuradores. Não é antimagia. |
| Leitura de Conjuração | Contra Magos | 100 | Contra Magos | não | alto | 5 | Ler preparo, janela e intenção de conjuração. |
| Ponto Cego | Contra Magos | 100 | Contra Magos | não | alto | 5 | Explorar o Ângulo ruim do conjurador. |
| Punição de Abertura | Contra Magos | 100 | Contra Magos | não | alto | 5 | Punir fisicamente a janela criada pelo oponente. |
| Ki | Ki e Zetten | 100 | Bárbaro, Culto, Contra Magos, Instinto | sim | alto | 5 | Leitura avançada de presença, intenção e timing. |
| Ki II | Ki e Zetten | 120 | Ki | sim | alto | 6 | Ki mais consistente e refinado. |
| Ki III | Ki e Zetten | 140 | Ki II | sim | alto | 6 | Ki avançado. |
| Zetten | Ki e Zetten | 120 | Ki, Explosão III, Ponto Fraco III | sim | alto | 6 | Ápice físico ofensivo concentrado. |
| Zetten II | Ki e Zetten | 140 | Zetten | sim | alto | 6 | Zetten mais refinado. |
| Zetten III | Ki e Zetten | 160 | Zetten II | sim | extremo | 7 | Zetten em grau extremo. |
| Ápice Físico | Ki e Zetten | 180 | Ki III, Zetten III | sim | extremo | 7 | Marco final simbólico e mecânico da rota física pura. |

## Observações

- Contra Magos não é antimagia: lá e pune janelas físicas de conjuração.
- Ki e Zetten não são liberados automaticamente pelo bot. O sistema só registra custo, requisito e status.
- O visual aprovado é estático; o renderer injeta status nos blocos do SVG sem redesenhar layout.
