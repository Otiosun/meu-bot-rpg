# Mundos dos Sonhos — políticas operacionais V1

Estado: provisório até a publicação.

## Vagas

- A distribuição é persistida em números inteiros por incursão.
- O comprador ocupa uma vaga confirmada ao aprovar a aquisição.
- Vagas de `squad` aceitam somente personagens do esquadrão comprador.
- Vagas de `invited` podem ser preenchidas por indicação administrativa ou do comprador.
- Vagas de `public` são destinadas a seleção pública, evento, missão, sorteio ou decisão administrativa registrada.
- Um personagem não pode possuir duas vagas ativas na mesma incursão.
- Recusa, remoção ou substituição preserva o registro anterior e cria ou utiliza uma vaga sucessora.
- Depois do início, a composição fica bloqueada. Exceções futuras precisarão de operação administrativa específica e auditada.

## Início e progressão

- Uma incursão somente pode começar ao atingir o mínimo de participantes confirmados.
- A confirmação do mínimo muda o estado para `ready`.
- O início fixa o primeiro capítulo e bloqueia alterações comuns de vagas.
- O avanço não pode retroceder capítulos.
- Ultrapassar os capítulos conhecidos exige liberação administrativa explícita.
- Pausa e retomada preservam capítulo e participantes.

## Cancelamento e reembolso

### Antes da aprovação

Nenhum Yul foi debitado. A solicitação pode ser recusada ou cancelada sem reembolso.

### Depois da aprovação e antes do início

O cancelamento não gera devolução automática. O caso entra em revisão administrativa. Uma eventual devolução deve ser feita por transação inversa auditada, vinculada ao código da solicitação.

### Depois do início

Não existe reembolso automático. Exceções ficam restritas a erro técnico comprovado, cancelamento causado pela administração ou impossibilidade operacional reconhecida.

### Falha técnica durante aprovação

A aprovação, o desconto, a criação da incursão e das vagas formam uma única operação. Se qualquer etapa falhar, o banco executa rollback e não mantém desconto isolado.

## Pagamento manual

- O site não confirma automaticamente dinheiro real.
- A administração verifica o pagamento fora do sistema e registra somente referência e estado necessários.
- O método de pagamento não altera dificuldade, avaliação, chance ou qualidade dos Fragmentos.

## Fragmentos

- Todo Fragmento possui versão e histórico.
- Alterar um Fragmento não apaga a versão anterior.
- A concessão identifica portador, responsável e motivo.
- Transferir um Fragmento já possuído exige ação forçada e justificativa auditável.
- Apenas estados `active`, `sealed` e `changed` marcados como públicos aparecem no arquivo público.
