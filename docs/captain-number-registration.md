# Cadastro seguro dos Capitães por número

Este procedimento depende das PRs de Capitães/Estrelas e personas já aprovadas e deve ser executado somente após backup e criação dos novos esquadrões.

Nunca registre números reais em arquivo versionado, issue, PR ou log público.

## Regras

- Use o número brasileiro com DDI `55`, DDD e telefone.
- São aceitos 12 ou 13 dígitos no total.
- Espaços, `+`, parênteses e traços são removidos antes da validação.
- Execute primeiro sem `--apply` para revisar o plano.
- `--apply` cria um backup SQLite verificado antes da alteração.
- `main_plus_captain` preserva integralmente o personagem principal da conta.
- `captain_only` cria uma conta-base somente quando o número ainda não possui personagem principal.
- Se `captain_only` encontrar outro personagem na conta, o cadastro é bloqueado por `captain_only_account_has_main_character`.
- O cargo é vinculado ao número/JID real; a identidade visual do Capitão fica em perfil separado.

## Chaves e modos

- `trevos_da_esperanca` — Outis Vermilion — `main_plus_captain`
- `corte_dourada_dos_deuses` — Shiraman B. Whitëmor — `main_plus_captain`
- `mephistopolis` — Dante — `main_plus_captain`
- `veu_negro` — Sousoke Aizen — `captain_only`

## Prévia dos três Capitães com personagem principal

```bash
npm run register:captain -- \
  --phone 55DDDNUMERO \
  --squad trevos_da_esperanca \
  --captain-name "Outis Vermilion" \
  --mode main_plus_captain \
  --assigned-by SEU_JID
```

Troque apenas número, esquadrão e nome para Shiraman e Dante. Não use `--apply` até o JSON da prévia confirmar:

- `accountExists: true`
- `willCreateCaptainOnlyAccount: false`
- `preserveMainCharacter: true`
- conta, esquadrão e nome corretos

## Aizen, sem personagem principal

```bash
npm run register:captain -- \
  --phone 55DDDNUMERO \
  --squad veu_negro \
  --captain-name "Sousoke Aizen" \
  --mode captain_only \
  --assigned-by SEU_JID
```

A prévia correta deve indicar:

- `accountExists: false`, caso o número ainda não tenha registro;
- `willCreateCaptainOnlyAccount: true`;
- `preserveMainCharacter: false`;
- esquadrão `Véu Negro`.

Se aparecer `captain_only_account_has_main_character`, não aplique. Revise o número ou use `main_plus_captain` somente se aquela conta realmente tiver um personagem principal a preservar.

## Aplicação

Depois de revisar a prévia, repita o mesmo comando com `--apply`.

Execute um Capitão por vez e confirme o resultado antes de prosseguir ao próximo.

Exemplo:

```bash
npm run register:captain -- \
  --phone 55DDDNUMERO \
  --squad veu_negro \
  --captain-name "Sousoke Aizen" \
  --mode captain_only \
  --assigned-by SEU_JID \
  --apply
```

## Dados opcionais do perfil

O comando aceita:

- `--magic`
- `--grimoire`
- `--race`
- `--class`
- `--kingdom`
- `--age`
- `--gender`
- `--appearance`
- `--image`
- `--biography`
- `--personality`

Esses dados alimentam o cartão e a ficha de Capitão sem alterar a ficha principal da conta.

## Verificação após cada cadastro

1. Confirmar o backup exibido pelo comando.
2. Confirmar o perfil em `clover_captain_profiles`.
3. Confirmar o cargo `captain` ativo e escopado ao esquadrão.
4. Confirmar `clover_squads.captain_player_id` e `captain_name`.
5. Entrar no site com o número.
6. Nas contas duplas, confirmar as opções “Personagem principal” e “Capitão”.
7. No Aizen, confirmar que aparece somente a persona de Capitão.
8. Confirmar que o Capitão só administra o próprio esquadrão.
