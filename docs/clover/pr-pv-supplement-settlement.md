# Settlement suplementar PR -> PV

Operação ADM restrita à policy aprovada `PRPV_1TO1_LRM_20260828_V1`,
1 PR = 1 PV. Não altera nem substitui o claim histórico.

`prPvSupplementService.buildSupplementManifest(db, playerId, campaignKey)`
produz o manifesto para revisão: saldo em centésimos, digest do ledger completo,
IDs dos créditos posteriores, referência/digest do claim e settlement anterior.
Sem claim anterior, distingue explicitamente a conversão do saldo líquido inicial.
Compras históricas já debitadas não são creditadas novamente.

Após revisão, `settleSupplement(db, adminContext, { operationKey, manifest })`
exige os gates ADM de PRE_RESET e capability `operation.apply`. Usa uma transação
`BEGIN IMMEDIATE` para adicionar PV inteiro, debitar exatamente o mesmo PR e
gravar o manifesto imutável na migration 0046. O manifesto deve permanecer igual
ao ledger atual; não reconstruir automaticamente um manifesto aprovado no retry.
Repetir a mesma chave e manifesto retorna o resultado anterior. Chaves dos dois
lançamentos e o digest de origem são únicos; conflitos não são reaproveitados.

PV canônico aceita apenas inteiros. O resto fracionário **continua no PR existente**,
sem apagamento, arredondamento econômico nem criação de outro saldo. O registro
de carry referencia esse PR; não representa um segundo crédito. Osborn mantém
0,4 PR após receber 1.356 PV; Roque mantém 0,2 PR após receber 1.840 PV suplementares.
O claim anterior de Roque permanece intacto.

Preview e conversão de launch aceitam somente carry com digest, saldo e lançamentos
pareados verificados. Um novo lançamento PR bloqueia essa aceitação até um novo
settlement. Novos créditos podem completar um PV usando o carry anterior, sem
consumi-lo duas vezes. A zeragem histórica IEEE-754 é reconhecida somente com a
chave, aprovação e metadata canônicas, antes do primeiro crédito pós-claim;
estornos econômicos não passam como créditos positivos.

Validação: `node --test --test-concurrency=1 tests/prPvSupplement.test.js`
e suites de preview/F10. Execução em DB live exige autorização operacional separada.
