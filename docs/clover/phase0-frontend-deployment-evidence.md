# Fase 0 — evidência do frontend em produção

Coleta realizada em 31/07/2026 pela integração da Vercel e confrontada com o GitHub.

## Projeto canônico

```text
Projeto: clover-multicolor
Project ID: prj_de9PyIWAiXq1sBZrhKaFmDQiRYCV
Deployment ID: dpl_EFwt82xmkUDuTBuYfBdQRujLQvAK
Estado: READY
Target: production
Branch: main
GitHub SHA: 788ced98c0e67987490507fe2c01c083243ad1b5
Mensagem: fix: update Clover API quick tunnel fallback
```

Domínios associados ao projeto:

```text
clover-multicolor.vercel.app
clover-multicolor-bellcranel1921-4681s-projects.vercel.app
clover-multicolor-git-main-bellcranel1921-4681s-projects.vercel.app
```

O SHA do deployment de produção coincide exatamente com o `main` observado no repositório `Otiosun/Clover-multicolor` durante a Fase 0.

## Projeto duplicado observado

```text
Projeto: clover-multicolor-vercel-main-deploy-20260731-0001
Project ID: prj_K8B2elvmYZN1RjDCwZJr2roBtLXr
Deployment ID: dpl_BdAVR4AQ6hxMgPepR5VDgLxpb76s
Estado: READY
Target: production
Git ref: HEAD
Git SHA registrado: 43ba8dc735895f3a60669057bae67c6fa7581466
Git dirty: 1
Actor: codex
```

Esse projeto possui apenas seus próprios domínios gerados e não possui `clover-multicolor.vercel.app`. Portanto, ele não é a referência canônica de produção.

Não apagar ou alterar o projeto duplicado durante a Fase 0. Primeiro deve-se verificar se algum link, teste ou integração ainda aponta para ele. Depois disso, ele pode ser classificado como artefato descartável ou mantido como evidência histórica.

## Conclusão

- [×] Projeto canônico identificado
- [×] Deployment de produção identificado
- [×] SHA do frontend em produção confirmado
- [×] SHA coincide com o `main` atual
- [×] Projeto duplicado separado da referência canônica
- [ ] Verificar referências externas ao projeto duplicado
- [ ] Arquivar ou remover o duplicado somente após essa verificação

O frontend deixa de ser uma incógnita da Fase 0. A evidência ainda pendente é o SHA realmente executado pelo backend local e a auditoria do banco vivo.
