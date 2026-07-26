'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    createDreamWorld,
    ensureDreamWorldsSchema,
} = require('../helpers/clover/dreamWorldsService');
const {
    createResonanceFragment,
    ensureDreamOperationsSchema,
} = require('../helpers/clover/dreamWorldsOperationsService');

function argument(name) {
    const prefix = `--${name}=`;
    const item = process.argv.slice(2).find((value) => value.startsWith(prefix));
    return item ? item.slice(prefix.length) : null;
}

function hasFlag(name) {
    return process.argv.slice(2).includes(`--${name}`);
}

function assertPreviewPath(filename) {
    if (!hasFlag('allow-preview-write')) {
        throw new Error('Seed bloqueado. Use --allow-preview-write somente em uma cópia de preview.');
    }
    const normalized = path.resolve(filename).toLowerCase();
    const allowed = ['backup', 'preview', 'staging', 'sandbox', 'test', 'copy', 'copia'];
    if (!allowed.some((token) => normalized.includes(token))) {
        throw new Error('Caminho recusado: o banco precisa estar claramente identificado como backup, preview, staging, sandbox, test ou cópia.');
    }
}

async function findWorld(db, slug) {
    return db.get('SELECT * FROM clover_dream_worlds WHERE slug = ? COLLATE NOCASE', [slug]);
}

async function findFragment(db, slug) {
    return db.get('SELECT * FROM clover_resonance_fragments WHERE slug = ? COLLATE NOCASE', [slug]);
}

async function main() {
    const databaseInput = argument('db');
    if (!databaseInput) {
        throw new Error('Informe --db=CAMINHO_DA_COPIA.sqlite.');
    }
    const filename = path.resolve(databaseInput);
    assertPreviewPath(filename);
    if (!fs.existsSync(filename)) throw new Error(`Cópia não encontrada: ${filename}`);

    const db = await open({ filename, driver: sqlite3.Database });
    const actorId = argument('actor') || 'dream-preview-seed@system';
    try {
        await db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
        await ensureDreamWorldsSchema(db);
        await ensureDreamOperationsSchema(db);

        let world = await findWorld(db, 'a-cidade-que-esqueceu-o-sol');
        if (!world) {
            const created = await createDreamWorld(db, {
                name: 'A Cidade que Esqueceu o Sol',
                slug: 'a-cidade-que-esqueceu-o-sol',
                universe: 'Manifestação Original do Arquivo',
                arc: 'O Sino da Última Manhã',
                synopsis: 'Uma cidade permanece presa numa noite sem fim. Os magos precisam descobrir por que os sinos ainda anunciam uma manhã que ninguém consegue lembrar.',
                dreamType: 'assumed_identity',
                rank: 'A',
                status: 'available',
                riskLevel: 'alto',
                yullsPrice: 2000,
                manualPaymentEnabled: true,
                manualPriceLabel: 'Confirmação manual de preview',
                minPlayers: 3,
                maxPlayers: 5,
                slots: { squad: 2, invited: 1, public: 2 },
                knownChapters: 3,
                publicRisks: [
                    'Morte real dentro da manifestação',
                    'Confusão progressiva de memórias',
                    'Grimório original temporariamente selado',
                ],
                rules: [
                    'Nenhum mago atravessa sozinho',
                    'A identidade assumida precisa cumprir o papel central da história',
                    'Abandonar o arco pode impedir a liberação da incursão',
                ],
                fragmentCategories: ['style', 'trait', 'title'],
                metadata: { previewSeed: true, nonCanonical: true },
            }, actorId);
            world = await findWorld(db, created.slug);
        }

        const fragments = [
            {
                name: 'Postura da Lua Partida',
                slug: 'postura-da-lua-partida',
                category: 'style',
                rarity: 'Ressonância rara',
                publicDescription: 'Um estilo de combate que conserva a disciplina corporal de uma guarda que protegeu a cidade durante a noite eterna.',
                effectText: 'Permite adaptar movimentos defensivos a ataques em arco e mudanças bruscas de direção.',
                restrictionsText: 'Não reproduz a força, a magia ou a experiência integral da identidade de origem.',
                status: 'active',
            },
            {
                name: 'Olhar da Última Manhã',
                slug: 'olhar-da-ultima-manha',
                category: 'trait',
                rarity: 'Ressonância incomum',
                publicDescription: 'Uma marca de atenção persistente, nascida de alguém que continuou procurando o amanhecer mesmo depois de todos esquecerem sua existência.',
                effectText: 'Favorece percepção de mudanças pequenas em padrões, rotinas e ambientes conhecidos.',
                restrictionsText: 'Não concede visão sobrenatural nem substitui sentidos, atributos ou perícias do personagem.',
                status: 'active',
            },
            {
                name: 'Nome que o Sol Esqueceu',
                slug: 'nome-que-o-sol-esqueceu',
                category: 'title',
                rarity: 'Ressonância selada',
                publicDescription: 'Um título preservado pelo Arquivo para o mago que carregou uma identidade até o fim sem permitir que ela apagasse seu nome original.',
                effectText: null,
                restrictionsText: 'Efeito e critérios completos permanecem selados para o preview.',
                status: 'sealed',
            },
        ];

        const createdFragments = [];
        for (const input of fragments) {
            let fragment = await findFragment(db, input.slug);
            if (!fragment) {
                const created = await createResonanceFragment(db, {
                    ...input,
                    originWorldId: Number(world.id),
                    publicVisible: true,
                    metadata: { previewSeed: true, nonCanonical: true },
                }, actorId);
                fragment = await findFragment(db, created.slug);
            }
            createdFragments.push({ id: Number(fragment.id), slug: fragment.slug, name: fragment.name });
        }

        console.log(JSON.stringify({
            ok: true,
            database: filename,
            warning: 'Conteúdo de preview não canônico. Não usar no banco vivo.',
            world: { id: Number(world.id), slug: world.slug, name: world.name },
            fragments: createdFragments,
        }, null, 2));
    } finally {
        await db.close();
    }
}

main().catch((error) => {
    console.error('Seed de preview interrompido:', error?.stack || error?.message || error);
    process.exitCode = 1;
});
