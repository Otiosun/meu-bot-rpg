# FASE 2 — cleanup final dos ensureColumn de jogadores

Data: 18/08/2026

## Pré-requisitos já fechados

As migrations e o pre-bootstrap canônico cobrem agora os três blocos finais de `jogadores`:

- 0016 — 8 campos de história/narrativa;
- 0017 — 4 campos de estado/acesso de jogo;
- 0018 — `patente`.

Todas as 13 colunas são garantidas antes do legacy em bancos ainda não adotados.

## Deleções mecânicas autorizadas

Remover exatamente estas 13 chamadas de `database/legacy.js`:

1. `jogadores.historia_status`
2. `jogadores.historia_status_updated_at`
3. `jogadores.historia_aprovada_at`
4. `jogadores.historia_aprovada_by`
5. `jogadores.historia_pv_sent_at`
6. `jogadores.historia_motivo`
7. `jogadores.gancho_narrativo`
8. `jogadores.historias_extras`
9. `jogadores.jogo_status`
10. `jogadores.jogo_liberado_at`
11. `jogadores.jogo_liberado_by`
12. `jogadores.jogo_bloqueio_motivo`
13. `jogadores.patente`

Nenhum CREATE, índice, normalização, UPDATE, writer ou outro ensure pode ser alterado.

## Estado esperado depois do cleanup

- 116 targets migrados únicos até a 0018;
- 28 targets já presentes em CREATE canônico;
- 88 targets fora do CREATE e providos por migrations/pre-bootstrap;
- 0 ensureColumn coberto por migrations;
- exatamente 9 ensureColumn não migrados permanecem:
  - 8 em `clover_squads`;
  - 1 em Raid.

## Dependências que devem permanecer

Além das dependências anteriores, o cleanup deve preservar explicitamente:

- `idx_jogadores_historia_status`;
- `idx_jogadores_jogo_status`;
- `idx_jogadores_aparencia_normalizada`.

## Transporte

A alteração de `database/legacy.js` deve ser feita em clone descartável no Windows com:

- base SHA e blob SHA exatos;
- 13 alvos encontrados exatamente uma vez cada;
- diff exato de 0 adições / 13 deleções;
- 9 ensures restantes;
- `node --check`;
- testes estáticos do cleanup;
- `git diff --check`;
- anti-race de `main` e da branch imediatamente antes do push;
- push fast-forward sem force;
- confirmação do blob remoto calculado localmente.

Nenhum banco, PM2, Mudzap, Raid, Squads ou projeto live é acessado pelo transporte.
