# P0 — Integridade do snapshot de recompensas

## Falha confirmada

O snapshot armazenava `starBeneficiarySquadKey`, mas removia esse campo antes de calcular o hash. Assim, o esquadrão beneficiário podia mudar — ou o JSON armazenado podia ser adulterado — sem invalidar a proposta.

## Contrato corrigido

- todo campo que altera destinatário, elegibilidade ou quantidade participa do hash;
- o snapshot usa versão de esquema 2;
- propostas pendentes na versão 1 não podem ser aprovadas nem tratadas como duplicatas válidas;
- o JSON armazenado é reserializado e conferido contra o próprio hash antes da comparação com o estado atual;
- alteração no payload armazenado retorna `proposal_snapshot_tampered`;
- snapshot inválido retorna `proposal_snapshot_invalid`;
- versão antiga retorna `proposal_snapshot_legacy`;
- mudança legítima após submissão retorna `proposal_stale`;
- a chave idempotente inclui proposta, versão e hash aprovado.

## Limite desta entrega

Esta correção fecha a adulteração e o destinatário fora do hash. Ela ainda não cria uma tabela imutável de revisões. O versionamento histórico completo será tratado na reconstrução do fluxo de propostas.
