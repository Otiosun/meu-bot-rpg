# Clover RPG — Runtime e release reproduzíveis da FASE 1

Data: 17/08/2026

## Objetivo

Eliminar a dependência implícita do Node instalado na máquina/runner e transformar runtime, lockfile e entrypoint de produção em contrato verificável.

## Runtime canônico alvo

- Node.js: `24.19.0` (linha 24 LTS)
- npm: `11.17.0`
- lockfile: versão 3
- PM2: `ecosystem.clover.config.cjs`
- processo: `clover-rpg`
- entrypoint: `scripts/startCloverSiteStack.js`
- child: `index.js`

O Windows live auditado na FASE 0 continua em Node `24.14.1`. Isso é **drift conhecido**. Esta mudança não atualiza Node no Windows e não reinicia PM2/Mudzap.

## Fonte de verdade

`config/runtime-reproducibility.json` define o contrato de runtime. `.node-version` e `.nvmrc` precisam coincidir exatamente com ele. O checker também valida que `package.json` e `package-lock.json` continuam coerentes entre si e que o lockfile permanece na versão declarada.

`package.json` e `package-lock.json` permanecem byte a byte inalterados. A resolução de dependências não é modificada nesta etapa; o npm exato é validado pelo checker no gate estrito.

## Checker

`scripts/checkRuntimeReproducibility.js` valida:

1. manifest, `.node-version` e `.nvmrc`;
2. `package.json` versus raiz do lockfile;
3. PM2 `clover-rpg` e seu entrypoint;
4. stack usando `process.execPath` para iniciar `index.js`;
5. workflows usando major Node 24 ou `.node-version`;
6. nenhum job que execute `node`, `npm` ou `npx` sem `actions/setup-node`;
7. hashes SHA-256 dos arquivos críticos;
8. head Git quando disponível;
9. Node/npm observados versus esperados.

Modo normal reporta drift. `--require-current-runtime` falha fechado se Node/npm não forem exatamente os targets.

## Workflows

Os workflows ainda presos a Node 20/22 foram alinhados ao major 24. Os workflows que já estavam em 24 não foram reformatados nem ampliados desnecessariamente.

O único job encontrado executando Node sem setup explícito (`source-safety` do release candidate) agora recebe `actions/setup-node`.

Foi adicionado `runtime-reproducibility.yml`, que usa `.node-version`, executa `npm ci`, chama o checker diretamente em modo estrito e roda os contratos de runtime + banco.

A uniformização de **todos** os workflows para um único mecanismo exato (`node-version-file`) pertence à FASE 10, CI definitiva. Nesta fase, o requisito é: nenhum workflow fora do major 24 e caminho de release pinado exatamente.

## Release plan

`scripts/prepareCloverProductionRelease.js` agora incorpora a proveniência do runtime e, por padrão, exige correspondência exata de Node/npm antes de gerar um plano de produção.

Assim, um Windows ainda em 24.14.1 não pode ser tratado acidentalmente como candidata reproduzível para o target 24.19.0.

## Validação isolada

- YAML: 36/36 workflows parseados com sucesso no laboratório.
- contratos de runtime: 5/5 PASS na reprodução final.
- contratos de runtime + banco: 11/11 PASS na candidata validada antes da serialização final.
- checker não estrito reportou corretamente Node 22.16.0/npm 10.9.2 como drift do runner de laboratório.
- checker estrito falhou corretamente com `node_version_mismatch` no mesmo runner.
- simulação do preparador de release capturou heads backend/frontend, hashes críticos e runtime esperado/observado.
- nenhum dependency range foi alterado.
- `package.json` e `package-lock.json` permanecem fora do diff.

## Segurança

- nenhum deploy;
- nenhum restart/reload;
- nenhum PM2/Mudzap alterado;
- nenhum banco live acessado;
- nenhuma migration live aplicada;
- nenhum segredo/identidade incluído.

**Gate de runtime/proveniência da FASE 1: candidato a PASS após revisão/merge do PR correspondente.**
