# QG dos Esquadrões — Especificação Mestre

> **Versão:** 0.1 — primeiro rascunho editável  
> **Status:** experimental; nada aqui entra em produção automaticamente  
> **Objetivo deste arquivo:** concentrar decisões, dúvidas, integrações e fases do mapa interativo dos QGs sem duplicar as regras existentes do bot.

---

## 0. Como usar este arquivo

Este documento é a fonte de contexto do projeto. Ele deve ser atualizado sempre que uma decisão importante for tomada.

Use estes estados:

- `FECHADO`: decisão válida até ser explicitamente substituída.
- `EXPERIMENTO`: ideia que precisa de protótipo ou teste.
- `PENDENTE`: pergunta ainda sem resposta.
- `SUBSTITUÍDO`: decisão antiga mantida apenas para histórico.

Ao mudar uma regra importante, registre também a alteração na seção **Registro de decisões**.

---

## 1. Visão do produto

### 1.1 O que estamos construindo

Um **mapa interativo, visto de cima, do quartel-general de cada esquadrão**.

O mapa não é um jogo separado e não substitui o RPG narrativo. Ele representa visualmente o desenvolvimento coletivo do esquadrão e serve como porta de entrada para sistemas já existentes ou futuros.

O jogador deve conseguir:

1. reconhecer imediatamente o próprio QG;
2. perceber o que o esquadrão já conquistou;
3. identificar o que pode ser construído depois;
4. clicar em estruturas para consultar ou utilizar funções;
5. sentir que sua participação individual contribui para algo coletivo e permanente;
6. ser conduzido de volta à escrita e à narrativa quando isso fizer sentido.

### 1.2 Sensação desejada

O QG precisa transmitir:

- pertencimento ao esquadrão;
- progresso coletivo visível;
- curiosidade por novas áreas;
- organização, sem parecer uma planilha;
- estética coerente com **Black Clover**, não com fantasia mágica genérica;
- conforto visual em celular;
- satisfação ao ver uma construção nova aparecer no terreno.

### 1.3 O que não estamos construindo

- um RPG completo dentro do navegador;
- um simulador com personagem andando pelo mapa;
- um tycoon com produção automática infinita;
- um sistema paralelo de PH, Estrelas, treinos, raids ou árvores;
- um mapa do mundo inteiro;
- animações pesadas ou decoração sem função.

---

## 2. Decisões já fechadas

| ID | Estado | Decisão |
|---|---|---|
| QG-001 | FECHADO | O QG será um mapa interativo visto de cima. |
| QG-002 | FECHADO | O site será a superfície visual principal; o bot continua sendo a autoridade das regras. |
| QG-003 | FECHADO | Custos, requisitos, permissões, compras e saldos não serão recalculados no frontend. |
| QG-004 | FECHADO | Nem toda benfeitoria exigirá cena. Algumas serão sistêmicas, outras narrativas e outras híbridas. |
| QG-005 | FECHADO | A mecânica deve incentivar narrativa quando houver motivo real, sem transformar toda interação em obrigação de escrita. |
| QG-006 | FECHADO | O primeiro protótipo será pequeno, editável e reversível. |
| QG-007 | FECHADO | O primeiro mapa será somente leitura: exibirá o estado real do esquadrão sem criar compras ou recompensas novas. |
| QG-008 | FECHADO | O mapa não deve duplicar o sistema de treino, raid, avaliação, PH ou árvores já existente. |
| QG-009 | FECHADO | Cada construção comprada precisa ter reflexo visual e motivo real de consulta ou uso. |
| QG-010 | FECHADO | O projeto será desenvolvido em ciclos curtos de protótipo, avaliação e correção visual. |

---

## 3. Estado atual do sistema

### 3.1 Backend e bot

O sistema atual já oferece a base necessária para o QG:

- esquadrões e vínculo de membros;
- Capitão e Vice-Capitão;
- Estrelas Atuais;
- Estrelas no Histórico;
- Estrelas Negras;
- Graus de Renome;
- histórico e ledger do esquadrão;
- catálogo oficial de 41 benfeitorias em 7 setores;
- compra protegida das benfeitorias;
- pré-requisitos, custo, Grau mínimo e Histórico mínimo;
- permissões por cargo e escopo;
- missões e Treinos de Esquadrão via raids;
- limites mensais;
- progressão por PH;
- teto semanal compartilhado por fontes de PH;
- árvores de desenvolvimento e aprovações;
- filas e fluxos administrativos de avaliação.

### 3.2 Site

A central atual do esquadrão já pode apresentar:

- comando e liderança;
- Estrelas e Renome;
- membros e participação;
- missões e treinos recentes;
- limites mensais;
- histórico de Estrelas;
- benfeitorias adquiridas, disponíveis e bloqueadas;
- informações diferentes conforme o cargo da sessão.

### 3.3 Regra de arquitetura

O mapa deve consumir esse estado existente.

```text
BANCO / BOT
    ↓
API DO QG
    ↓
ESTADO AUTORIZADO DO ESQUADRÃO
    ↓
MAPA VISUAL
    ↓
PAINÉIS E AÇÕES PERMITIDAS
```

O frontend nunca decide sozinho que uma construção foi comprada, liberada ou utilizável.

---

## 4. Arquitetura funcional do QG

### 4.1 Camada 1 — Fonte de verdade

Responsável por:

- catálogo de benfeitorias;
- aquisição real;
- requisitos;
- saldo;
- Renome;
- permissões;
- limites;
- auditoria;
- recompensas e progressão.

Essa camada permanece no backend.

### 4.2 Camada 2 — Tradução visual

Responsável por relacionar cada benfeitoria a:

- zona do mapa;
- posição;
- estrutura visual;
- tamanho;
- variação estética;
- estado visual;
- painel aberto ao clique.

Essa camada poderá existir em um arquivo como:

```text
src/features/squad-map/squad-upgrade-visual-map.ts
```

Ela não conterá custo, saldo ou regra de compra.

### 4.3 Camada 3 — Interação

Uma construção poderá abrir um dos seguintes tipos de módulo:

| Tipo | Comportamento |
|---|---|
| Informativo | Exibe estado, histórico, membros, pistas ou dados relacionados. |
| Sistêmico | Usa diretamente um sistema existente sem exigir cena. |
| Narrativo | Cria ou registra uma atividade cuja conclusão depende de escrita. |
| Híbrido | Oferece uso básico sistêmico e benefício adicional mediante narrativa ou aprovação. |
| Contextual | Ainda não possui ação própria, mas altera a leitura e identidade do QG. |

---

## 5. Estados visuais das construções

### 5.1 Estados do primeiro protótipo

| Estado | Exibição |
|---|---|
| Ausente | O espaço pode ficar vazio ou mostrar fundação discreta, conforme teste visual. |
| Bloqueada | Silhueta, planta ou marcação sutil; informa os requisitos reais ao toque. |
| Disponível | Área destacada de forma contida; informa que pode ser comprada pelo fluxo autorizado. |
| Adquirida | Construção completa visível no terreno e acessível ao clique. |

### 5.2 Estados futuros

- em construção;
- ativa nesta semana;
- uso esgotado;
- ação aguardando avaliação;
- danificada ou afetada por evento narrativo;
- aprimorada;
- marco coletivo concluído.

Esses estados não entram no primeiro protótipo sem suporte real do backend.

---

## 6. Estrutura inicial do mapa

### 6.1 Organização por zonas

O terreno será dividido em áreas funcionais, mas deve continuar parecendo um QG orgânico, não uma grade de menu.

Zonas candidatas:

1. acesso e comando;
2. treino e preparo;
3. pesquisa e magia;
4. cura e recuperação;
5. estratégia e logística;
6. memória e convívio;
7. defesa e estruturas externas.

A distribuição final depende do catálogo oficial das 41 benfeitorias e de testes de composição.

### 6.2 Regras de composição

- leitura clara mesmo sem texto sobre o mapa;
- estruturas importantes identificáveis pela forma;
- caminhos conectando áreas principais;
- espaço para crescimento sem reconstruir o mapa inteiro;
- nenhum objeto clicável pequeno demais no celular;
- detalhes decorativos não podem competir com áreas interativas;
- zoom opcional, mas o estado geral do QG precisa ser reconhecível de imediato;
- sem personagem controlável;
- sem animação contínua obrigatória.

---

## 7. Primeiro protótipo funcional

### 7.1 Objetivo

Comprovar que o mapa consegue receber o estado real de um esquadrão e montar visualmente o QG correspondente.

### 7.2 Escopo

O protótipo deve:

1. abrir dentro da área de Esquadrão do site;
2. identificar o esquadrão autorizado da sessão;
3. carregar as benfeitorias reais;
4. posicionar no terreno as estruturas adquiridas;
5. mostrar estados bloqueado, disponível e adquirido;
6. abrir um painel ao clicar em uma construção;
7. mostrar nome, setor, efeito publicado, custo, requisitos e estado;
8. funcionar em celular e desktop;
9. não realizar compras;
10. não conceder PH, Estrelas, itens ou qualquer recompensa.

### 7.3 Primeira fatia visual

Para o teste inicial, não é necessário desenhar as 41 construções em arte final.

O mapa pode começar com:

- um terreno-base;
- caminhos principais;
- zonas demarcadas;
- cinco a oito estruturas representativas;
- marcadores provisórios para as demais;
- painel lateral ou folha inferior para detalhes.

Os elementos provisórios devem ser fáceis de substituir sem alterar a lógica.

### 7.4 Critérios de aceitação

O protótipo será considerado válido quando:

- dois esquadrões com aquisições diferentes produzirem mapas diferentes;
- uma benfeitoria comprada no bot aparecer como adquirida após atualização;
- nenhuma regra estiver duplicada no frontend;
- o mapa continuar utilizável em tela pequena;
- o jogador entender, sem explicação longa, o que já possui e o que ainda pode alcançar;
- seja possível alterar posições, tamanhos e aparência sem reescrever o sistema.

---

## 8. Modelo editável de benfeitoria

Cada benfeitoria será documentada neste formato:

```yaml
id_oficial: ""
nome_oficial: ""
setor_oficial: ""
estado_do_design: PENDENTE

backend:
  custo: "vem da API"
  requisitos: "vem da API"
  compra: "permanece no bot"
  usos_existentes: []

mapa:
  zona: ""
  posicao: { x: 0, y: 0 }
  tamanho: ""
  estrutura_visual: ""
  variacoes: []

interacao:
  tipo: informativo | sistemico | narrativo | hibrido | contextual
  acao_principal: ""
  exige_cena: false
  cena_opcional: false
  exige_aprovacao: false
  sistema_reutilizado: ""
  modulo_novo_necessario: false

observacoes:
  - ""
```

---

## 9. Estudos iniciais — ainda não vinculados ao catálogo oficial

> Estes exemplos servem apenas para testar o formato. Os nomes, IDs e efeitos precisam ser confrontados com o catálogo real antes de virarem regra.

### 9.1 Área de treino

**Hipótese:** estrutura híbrida conectada aos Treinos de Esquadrão já existentes.

Possíveis funções:

- mostrar limite mensal atual;
- abrir a criação ou consulta de treino;
- registrar preparação prévia;
- oferecer benefício adicional apenas quando houver suporte sistêmico e regra aprovada;
- incentivar cena de treino sem exigir cena em todo uso.

Não deve:

- criar um segundo contador de treino;
- entregar PH fora do ledger;
- ignorar o teto semanal;
- conceder bônus apenas porque o jogador clicou.

### 9.2 Biblioteca ou área de estudo

**Hipótese:** estrutura híbrida ligada a conhecimento, requisitos narrativos e progressão controlada.

Possíveis funções:

- trilhas de estudo;
- barra de progresso por tema;
- marcos narrativos;
- histórico de pesquisas;
- requisitos para solicitar acesso a determinado conteúdo ou nó;
- atividades coletivas do esquadrão.

Não deve:

- comprar nó de árvore automaticamente;
- aprovar capacidade ou feitiço sem avaliador;
- substituir cenas e decisões narrativas relevantes.

### 9.3 Arquivo ou memória do esquadrão

**Hipótese:** módulo informativo ou híbrido.

Possíveis funções:

- histórico de missões;
- Estrelas recebidas e gastas;
- marcos do esquadrão;
- pistas descobertas;
- registros escritos por membros autorizados;
- linha do tempo da construção do QG.

### 9.4 Enfermaria ou recuperação

**Hipótese:** módulo sistêmico ou híbrido, dependente do sistema real de condições e recuperação.

Antes de projetar efeitos, é obrigatório mapear:

- condições existentes;
- consumíveis;
- tratamento em raids;
- tempo de recuperação;
- permissões;
- riscos de criar cura paralela.

---

## 10. Matriz das 41 benfeitorias

Esta seção será preenchida após a extração integral do catálogo oficial do backend.

| ID oficial | Nome | Setor | Adquirida? | Sistema existente relacionado | Tipo proposto | Módulo novo? | Estado do design |
|---|---|---|---|---|---|---|---|
| A EXTRAIR | — | — | vem da API | — | — | — | PENDENTE |

### Classificações possíveis

- `CONECTA AGORA`: já existe sistema compatível.
- `SOMENTE VISUAL`: representa progresso, sem ação própria no momento.
- `INFORMATIVA`: pode exibir dados existentes.
- `PRECISA DE DESIGN`: função ainda não definida.
- `PRECISA DE BACKEND`: depende de novo módulo.
- `FASE FUTURA`: complexidade ou dependências altas.

---

## 11. Contrato de dados visual — rascunho

Exemplo de configuração que poderá ser editada sem tocar nas regras:

```ts
export const squadUpgradeVisualMap = {
  "ID_OFICIAL": {
    zone: "training",
    position: { x: 42, y: 68 },
    size: "medium",
    structure: "training-yard-placeholder",
    panel: "upgrade-details",
  },
} as const;
```

O mapa deve cruzar essa configuração com o estado retornado pelo backend:

```ts
const visual = squadUpgradeVisualMap[upgrade.id]
const state = upgrade.acquired
  ? "acquired"
  : upgrade.available
    ? "available"
    : "locked"
```

A API continua sendo a fonte do estado.

---

## 12. Permissões

### Membro

- visualizar o próprio QG;
- abrir construções e informações liberadas;
- usar módulos permitidos para membros;
- acompanhar progresso coletivo.

### Capitão e Vice-Capitão

- tudo que o membro pode fazer;
- acesso às ações de gestão já permitidas pelo backend;
- visão de necessidades, requisitos e planejamento;
- nenhuma permissão criada apenas pelo frontend.

### Narrador e administração

- visualizar esquadrões dentro do escopo autorizado;
- acessar ferramentas específicas apenas quando a API confirmar permissão;
- acompanhar ações pendentes e marcos narrativos quando o módulo existir.

---

## 13. Direção visual provisória

### 13.1 Princípios

- top-down ilustrado, sem aparência de engine de jogo genérica;
- formas arquitetônicas inspiradas no mundo e na organização de Black Clover;
- identidade visual variável entre esquadrões no futuro;
- interface escura e legível, mas o terreno não precisa ser permanentemente escuro;
- textura e atmosfera controladas;
- pouca poluição;
- contraste suficiente entre cenário e elementos clicáveis;
- feedback rápido ao toque;
- nenhuma animação pesada necessária para parecer vivo.

### 13.2 O que testar no primeiro protótipo

- mapa fixo ilustrado versus terreno montado em camadas;
- painel lateral no desktop e folha inferior no celular;
- estruturas bloqueadas visíveis versus ocultas;
- rótulos sempre visíveis versus somente ao foco;
- zoom livre versus três níveis de zoom;
- caminhos predefinidos versus posicionamento modular.

---

## 14. Fases

### Fase 0 — Documento e auditoria

- [x] criar especificação mestre inicial;
- [ ] extrair as 41 benfeitorias do backend;
- [ ] relacionar cada benfeitoria a sistemas existentes;
- [ ] identificar lacunas reais;
- [ ] escolher a primeira fatia visual.

### Fase 1 — Mapa somente leitura

- [ ] criar rota experimental;
- [ ] carregar estado real do esquadrão;
- [ ] criar terreno inicial;
- [ ] posicionar estruturas por configuração;
- [ ] criar estados visuais;
- [ ] abrir detalhes ao clique;
- [ ] testar em celular.

### Fase 2 — Primeiros módulos

- [ ] escolher de três a cinco construções com encaixe real;
- [ ] reutilizar sistemas existentes;
- [ ] criar apenas endpoints estritamente necessários;
- [ ] adicionar auditoria e permissões;
- [ ] validar narrativa versus fricção.

### Fase 3 — Identidade dos esquadrões

- [ ] variações arquitetônicas;
- [ ] terreno e atmosfera;
- [ ] marcos visuais de Renome;
- [ ] evolução do QG;
- [ ] histórico visual de conquistas.

### Fase 4 — Expansão

- [ ] completar catálogo;
- [ ] eventos narrativos;
- [ ] módulos coletivos;
- [ ] melhorias de longo prazo;
- [ ] polimento e acessibilidade.

---

## 15. Pendências prioritárias

| ID | Pergunta | Estado |
|---|---|---|
| P-001 | O primeiro mapa usa um QG genérico de teste ou já representa um esquadrão específico? | PENDENTE |
| P-002 | Estruturas ainda não compradas aparecem como planta, silhueta ou ficam ocultas? | EXPERIMENTO |
| P-003 | O primeiro terreno será único ou já terá zonas variáveis? | PENDENTE |
| P-004 | Compra continuará apenas no bot durante todo o MVP ou chegará ao site depois? | PENDENTE |
| P-005 | Qual esquadrão será usado como piloto? | PENDENTE |
| P-006 | A Biblioteca existente no catálogo possui qual nome e efeito oficial? | PENDENTE |
| P-007 | Quais benfeitorias já possuem uso semanal publicado? | PENDENTE |
| P-008 | Quais módulos exigem uma nova fila de aprovação e quais podem reutilizar fluxos existentes? | PENDENTE |

---

## 16. Registro de decisões

### 2026-07-22 — Documento mestre inicial

- **Decisão:** criar um documento único e editável para preservar contexto, arquitetura e decisões do QG.
- **Motivo:** impedir que protótipos sejam construídos sobre suposições ou que decisões antigas sejam esquecidas.
- **Impacto:** toda implementação futura deve apontar para este documento ou atualizar seu conteúdo.
- **Status:** FECHADO.

### 2026-07-22 — Primeiro protótipo somente leitura

- **Decisão:** o primeiro protótipo usará o estado real do esquadrão, mas não criará novas mutações.
- **Motivo:** validar visual, arquitetura e compreensão antes de adicionar risco sistêmico.
- **Impacto:** nenhuma compra, recompensa ou aprovação nova entra na primeira entrega.
- **Status:** FECHADO.

---

## 17. Próxima ação concreta

Extrair do backend o catálogo integral das 41 benfeitorias e preencher a matriz com:

1. ID oficial;
2. nome oficial;
3. setor;
4. custo e requisitos;
5. efeito publicado;
6. forma de ativação;
7. aprovação exigida;
8. sistema existente relacionado;
9. classificação inicial;
10. dependências para o mapa.

Depois dessa extração, será escolhida a primeira fatia visual do mapa.
