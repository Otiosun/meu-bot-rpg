const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const { normalizeText } = require('../helpers/textUtils');

const DB_PATH = path.join(process.cwd(), 'banco.sqlite');
const BACKUP_DIR = path.join(process.cwd(), 'backups', 'historia-aprovada-202606120341');

const UPDATES = [
    {
        id: '15157493260535@lid',
        label: 'Yelena - 9998',
        hook: 'Bisturi Quebrado.',
        extras: [
            { type: 'traço', title: 'Mãos Precisas', description: '' },
            {
                type: 'traço novo',
                title: 'Gosto do Sangue',
                description: 'Yelena se familiarizou com o anormal desde muito cedo. Devido a isso, o gosto do sangue é, para ela, um vício. As vezes é difícil controlar as próprias ações quando os instintos falam mais alto, e, devido a isso, quando em descontrole, recebe um buff de 15% em alguma ação.',
            },
            {
                type: 'gn',
                title: 'Bisturi Quebrado.',
                description: 'Esse Bisturi quebrado foi um dos objetos mais usados pelo cuidador de Yelena. Por algum motivo, algo nele chama bastante atenção. Talvez pelos seus parâmetros estranhos, feito de aço e não qualquer outro material normal e comum. Detalhes intrínsecos nele incluem símbolos de, talvez, organizações ou cultos ocultos e desconhecidos. A quebra dele está justamente na agulha.',
            },
        ],
    },
    {
        id: '48387302895675@lid',
        label: 'Katherine - 0824',
        hook: 'Livro de Herança',
        extras: [
            { type: 'traço', title: 'Filho de Ofício', description: '' },
            {
                type: 'gn',
                title: 'Livro de Herança',
                description: 'Aos seus 10 anos de idade, Katherine recebeu de seus pais um estranho livro que, segundo eles, foi trazido do país de onde vieram. O idioma é desconhecido. É impossível entender, por meios comuns, qualquer coisa escrita nele. E os pais dela sempre evitavam o assunto.',
            },
        ],
    },
    {
        id: '126959367540919@lid',
        label: 'Emil - 2956',
        hook: 'O ***** ** *****a',
        extras: [
            { type: 'traço', title: 'Corpo de Combate', description: '' },
            {
                type: 'gn',
                title: 'O ***** ** *****a',
                description: '[...] portanto as vezes você é capaz de ouvir um estranho cochichar em seu ouvido. Um idioma desconhecido, uma voz do além, que mais parece o chiado do ar. Isso começou a acontecer com mais frequência depois que chegou a Clover e passou por tudo que passou.',
            },
        ],
    },
    {
        id: '225112322265288@lid',
        label: 'Ophelia - 589445',
        hook: 'O Lacre da Igreja',
        anomalia: '***** Amaldiçoada',
        extras: [
            {
                type: 'anomalia',
                title: '***** Amaldiçoada',
                description: 'Há algo muito estranho em Ophelia, algo que não deveria ser normal nesse mundo. Bem, ela não sabe que isso realmente existe, e tampouco seus significado. Mas talvez, quando estiver na situação perfeita e no tempo perfeito, efeitos estranhos possam se manifestar (narrativo).',
            },
            {
                type: 'gn',
                title: 'O Lacre da Igreja',
                description: 'Antes de fugir, Ophelia se despediu da igreja que a criou e levou consigo um pequeno lacre de cera usado nos documentos do templo. Não é relíquia sagrada, nem amuleto poderoso. É apenas o símbolo do lugar que a acolheu e também a ensinou a ter medo da própria magia.',
            },
        ],
    },
    {
        id: '59537340022832@lid',
        label: 'Ninguém - 657',
        hook: 'Justiça de Punho Fechado',
        extras: [
            { type: 'traço', title: 'Não Ajoelho', description: '' },
            {
                type: 'gn',
                title: 'Justiça de Punho Fechado',
                description: 'Ele ainda acredita em justiça, mas sua justiça vive perto demais da raiva. Cada insulto, cada olhar de nojo e cada risada sobre sua estatura empurram seu coração para uma conclusão perigosa. Talvez o mundo só respeite aquilo que apanha. Quando defende alguém discriminado, humilhado ou tratado como inferior, recebe +10% na ação. Porém, se usar essa mesma força para humilhar alguém mais fraco, o narrador pode marcar isso como avanço de sua corrupção moral.',
            },
        ],
    },
    {
        id: '147833361588309@lid',
        label: 'Gwen - 4155',
        hook: 'Flor que não Desabrocha.',
        extras: [
            {
                type: 'gn',
                title: 'Flor que não Desabrocha.',
                description: 'Gwen carrega em si uma magia de Roseira que deveria florescer, mas algo em sua trajetória interrompeu esse curso. Seus galhos nascem, seus espinhos se erguem, mas suas flores raramente se abrem por completo. Quando surgem, vêm murchas, curvadas ou secas. Devido a isso, seu poder mágico cresce em 10% passivamente.',
            },
        ],
    },
];

function parseExtras(value) {
    if (!value || value === '-' || value === '[]') return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function isCorruptedExtra(extra) {
    const blob = `${extra?.type || ''} ${extra?.title || ''} ${extra?.description || ''}`;
    return blob.includes('?');
}

function mergeExtras(current, incoming) {
    const cleanCurrent = current.filter((extra) => !isCorruptedExtra(extra));
    const result = [...cleanCurrent];
    for (const item of incoming) {
        const key = `${normalizeText(item.type)}|${normalizeText(item.title)}`;
        const exists = result.some((existing) => `${normalizeText(existing.type)}|${normalizeText(existing.title)}` === key);
        if (!exists) result.push(item);
    }
    return result;
}

async function main() {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });

    const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
    const ids = UPDATES.map((item) => item.id);
    const placeholders = ids.map(() => '?').join(',');
    const beforeRows = await db.all(`SELECT * FROM jogadores WHERE id IN (${placeholders})`, ids);
    fs.writeFileSync(
        path.join(BACKUP_DIR, 'jogadores-before-utf8-fix.json'),
        JSON.stringify(beforeRows, null, 2),
        'utf8'
    );

    const missing = ids.filter((id) => !beforeRows.some((row) => row.id === id));
    if (missing.length) throw new Error(`Players não encontrados: ${missing.join(', ')}`);

    await db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
        for (const update of UPDATES) {
            const current = beforeRows.find((row) => row.id === update.id);
            const mergedExtras = mergeExtras(parseExtras(current.historias_extras), update.extras);
            await db.run(
                `UPDATE jogadores
                 SET historia_status = 'aprovada',
                     historia_aprovada_at = COALESCE(historia_aprovada_at, CURRENT_TIMESTAMP),
                     historia_aprovada_by = COALESCE(historia_aprovada_by, 'codex'),
                     historia_status_updated_at = CURRENT_TIMESTAMP,
                     historia_motivo = NULL,
                     jogo_status = CASE
                         WHEN ficha_status = 'aprovada' AND personagem_aparencia_status = 'approved' THEN 'liberado'
                         ELSE jogo_status
                     END,
                     jogo_liberado_at = CASE
                         WHEN ficha_status = 'aprovada' AND personagem_aparencia_status = 'approved' THEN COALESCE(jogo_liberado_at, CURRENT_TIMESTAMP)
                         ELSE jogo_liberado_at
                     END,
                     jogo_liberado_by = CASE
                         WHEN ficha_status = 'aprovada' AND personagem_aparencia_status = 'approved' THEN COALESCE(jogo_liberado_by, 'codex')
                         ELSE jogo_liberado_by
                     END,
                     jogo_bloqueio_motivo = CASE
                         WHEN ficha_status = 'aprovada' AND personagem_aparencia_status = 'approved' THEN NULL
                         ELSE jogo_bloqueio_motivo
                     END,
                     gancho_narrativo = ?,
                     historias_extras = ?,
                     anomalia = CASE WHEN ? IS NOT NULL THEN ? ELSE anomalia END,
                     anomalia_key = CASE WHEN ? IS NOT NULL THEN NULL ELSE anomalia_key END
                 WHERE id = ?`,
                [
                    update.hook,
                    JSON.stringify(mergedExtras),
                    update.anomalia || null,
                    update.anomalia || null,
                    update.anomalia || null,
                    update.id,
                ]
            );
        }
        await db.exec('COMMIT');
    } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
    }

    const afterRows = await db.all(`SELECT * FROM jogadores WHERE id IN (${placeholders})`, ids);
    fs.writeFileSync(
        path.join(BACKUP_DIR, 'jogadores-after-utf8-fix.json'),
        JSON.stringify(afterRows, null, 2),
        'utf8'
    );

    await db.close();

    console.log(JSON.stringify({
        backupDir: BACKUP_DIR,
        updated: UPDATES.map((item) => ({
            id: item.id,
            label: item.label,
            hook: item.hook,
            extras: item.extras.map((extra) => extra.title),
            anomalia: item.anomalia || null,
        })),
    }, null, 2));
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});
