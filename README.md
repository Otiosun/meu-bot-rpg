# meu-bot-rpg

Bot WhatsApp/RPG em Node.js com Baileys e SQLite.

## Requisitos

- Node.js 18+
- npm

## Instalação

```bash
npm install
```

## Execução

```bash
node index.js
```

## Observações de segurança

O repositório já ignora pastas e arquivos sensíveis, como:

- `auth_info/`
- `config/owner-access.json`
- `config/custom-messages.json`
- bancos SQLite (`*.sqlite`, `*.db`)
- logs, cache e arquivos temporários

Se o bot precisar de credenciais, configure-as localmente e não as envie para o GitHub.
