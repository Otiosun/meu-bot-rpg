const fs = require('fs');

function loadRegions(tree) {
    if (!tree?.images?.regions || !fs.existsSync(tree.images.regions)) return {};

    try {
        return JSON.parse(fs.readFileSync(tree.images.regions, 'utf8'));
    } catch {
        return {};
    }
}

function resolveCaption(tree, regionKey) {
    if (regionKey === 'completo') return `${tree.icon} ${tree.label}`;
    return `${tree.icon} ${tree.label} — ${regionKey.replace(/_/g, ' ')}`;
}

async function tryLoadSharp() {
    try {
        return require('sharp');
    } catch {
        return null;
    }
}

async function sendTreeMap({
    sock,
    idChat,
    tree,
    regionKey = 'completo',
    caption,
    silentFallback = false,
}) {
    const fullImagePath = tree?.images?.full;
    const regionCaption = caption || resolveCaption(tree, regionKey);

    if (!fullImagePath || !fs.existsSync(fullImagePath)) {
        if (!silentFallback) {
            await sock.sendMessage(idChat, {
                text: '🗺️ O mapa visual da árvore física ainda não foi configurado em `assets/arvores/fisico_full.png`.',
            });
        }
        return { sent: false, reason: 'missing_full_image' };
    }

    if (regionKey === 'completo') {
        await sock.sendMessage(idChat, {
            image: fs.readFileSync(fullImagePath),
            caption: regionCaption,
        });
        return { sent: true, mode: 'full' };
    }

    const regions = loadRegions(tree);
    const region = regions[regionKey];
    if (!region) {
        await sock.sendMessage(idChat, {
            image: fs.readFileSync(fullImagePath),
            caption: `${regionCaption}\n\nRegião específica não encontrada. Enviei o mapa completo como fallback.`,
        });
        return { sent: true, mode: 'full_fallback_missing_region' };
    }

    const sharp = await tryLoadSharp();
    if (!sharp) {
        await sock.sendMessage(idChat, {
            image: fs.readFileSync(fullImagePath),
            caption: `${regionCaption}\n\nRecorte automático indisponível sem a dependência \`sharp\`. Enviei o mapa completo.`,
        });
        return { sent: true, mode: 'full_fallback_no_sharp' };
    }

    const buffer = await sharp(fullImagePath)
        .extract({ left: region.x, top: region.y, width: region.w, height: region.h })
        .resize({ width: 1100, withoutEnlargement: true })
        .png()
        .toBuffer();

    await sock.sendMessage(idChat, {
        image: buffer,
        caption: regionCaption,
    });

    return { sent: true, mode: 'crop' };
}

module.exports = {
    sendTreeMap,
};
