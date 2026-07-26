# Mundos dos Sonhos — políticas operacionais V1

Estado: política fechada para a V1. Mudanças futuras exigem nova versão e registro explícito.

## 1. Vagas e convocação

- A distribuição é persistida em números inteiros por incursão.
- O responsável pela aquisição ocupa uma vaga confirmada quando a solicitação é aprovada.
- Vagas de `squad` aceitam somente personagens do esquadrão responsável.
- Vagas de `invited` podem ser preenchidas por indicação administrativa ou do responsável.
- Vagas de `public` são destinadas a convocação pública, evento, missão, sorteio ou decisão administrativa registrada.
- Um personagem não pode possuir duas vagas ativas na mesma incursão.
- Recusa, remoção ou substituição preserva o registro anterior e cria ou utiliza uma vaga sucessora.
- Depois do início, a composição fica bloqueada. Exceções futuras exigirão operação administrativa específica e auditada.

## 2. Início e progressão

- Uma incursão somente pode começar ao atingir o mínimo de magos confirmados.
- A confirmação do mínimo muda o estado para `ready`.
- O início fixa o primeiro capítulo e bloqueia alterações comuns de vagas.
- O avanço não pode retroceder capítulos.
- Ultrapassar os capítulos conhecidos exige liberação administrativa explícita.
- Pausa e retomada preservam capítulo, participantes e histórico.
- Conclusão, fracasso e cancelamento são estados finais da incursão.

## 3. Cancelamento e reembolso

### 3.1 Antes da aprovação

- Nenhum Yul foi debitado.
- A solicitação pode ser recusada ou cancelada sem reembolso.
- O histórico da solicitação permanece preservado.

### 3.2 Depois da aprovação e antes do início

- A aprovação permanece registrada como fato histórico.
- A incursão e a Fenda podem ser marcadas como canceladas.
- Não existe devolução automática de Yuls.
- O cancelamento precisa registrar motivo no histórico da incursão e na auditoria.
- Uma eventual devolução exige transação inversa separada, auditada e vinculada ao código da solicitação.

### 3.3 Depois do início

- Não existe reembolso automático.
- Capítulos já iniciados ou concluídos não são apagados do histórico.
- Exceções ficam restritas a erro técnico comprovado, cancelamento causado pela administração ou impossibilidade operacional reconhecida.
- Mesmo em uma exceção, a devolução precisa ocorrer por operação financeira separada; cancelar a incursão nunca altera o saldo por conta própria.

### 3.4 Falha técnica durante aprovação

- Aprovação, desconto, criação da incursão e geração das vagas formam uma única transação.
- Se qualquer etapa falhar, o banco executa rollback.
- Não pode existir desconto isolado, incursão sem solicitação aprovada ou conjunto incompleto de vagas.
- Repetir a mesma aprovação deve retornar o resultado existente sem novo débito.

### 3.5 Estado da solicitação após cancelamento

- A solicitação permanece `approved`, pois o acesso chegou a ser aprovado e o débito ocorreu.
- O estado `cancelled` pertence à incursão e à Fenda.
- Essa separação impede que o histórico financeiro seja reescrito como se a aprovação nunca tivesse acontecido.

## 4. Pagamento manual

- O site não confirma automaticamente dinheiro real.
- A administração verifica o pagamento fora do sistema e registra somente referência e estado necessários.
- O método de pagamento não altera dificuldade, Rank, avaliação, chance ou qualidade dos Fragmentos.
- Cancelamento de pagamento manual segue a mesma política de revisão administrativa; o site não executa devolução externa.

## 5. Concorrência e idempotência

- Duas aprovações simultâneas da mesma solicitação devem produzir uma única incursão, um único débito e uma única auditoria de aprovação.
- Duas atribuições simultâneas para a mesma vaga devem permitir apenas um ocupante.
- Duas respostas simultâneas ao mesmo convite devem produzir somente uma decisão final.
- A proteção usa transações `BEGIN IMMEDIATE`, restrições de unicidade e chaves idempotentes.
- Erro de concorrência não pode ser convertido em duplicação silenciosa.

## 6. Fragmentos de Ressonância

- Todo Fragmento possui versão e histórico.
- Alterar um Fragmento não apaga a versão anterior.
- A concessão identifica portador, responsável e motivo.
- Transferir um Fragmento já possuído exige ação forçada e justificativa auditável.
- Apenas estados `active`, `sealed` e `changed` marcados como públicos aparecem no Arquivo de Ressonâncias.
- A versão registrada pelo Clover Multicolor prevalece sobre a obra de origem.

## 7. Regra de ouro

A forma de acesso concede uma história, não imunidade às consequências. Nenhum pagamento, aquisição ou decisão administrativa pode reduzir silenciosamente o risco da Fenda ou elevar a qualidade das recompensas.
