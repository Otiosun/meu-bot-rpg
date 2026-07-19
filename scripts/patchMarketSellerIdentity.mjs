import fs from "node:fs";

const servicePath = "helpers/clover/marketService.js";
const testPath = "tests/marketOperationsV1.test.js";
let service = fs.readFileSync(servicePath, "utf8");
let tests = fs.readFileSync(testPath, "utf8");

function replaceOnce(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: trecho encontrado ${count} vez(es)`);
  return source.replace(before, after);
}

function replaceAfter(source, marker, before, after, label) {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) throw new Error(`${label}: marcador não encontrado`);
  const beforeIndex = source.indexOf(before, markerIndex);
  if (beforeIndex < 0) throw new Error(`${label}: trecho não encontrado após marcador`);
  if (source.indexOf(before, beforeIndex + before.length) >= 0 && source.indexOf(before, beforeIndex + before.length) < source.indexOf("\nasync function ", markerIndex + marker.length)) {
    throw new Error(`${label}: trecho ambíguo`);
  }
  return source.slice(0, beforeIndex) + after + source.slice(beforeIndex + before.length);
}

const sellerHelpers = [
  "function serializeMarketSeller(row = {}) {",
  "    const name = row.seller_personagem_nome && row.seller_personagem_nome !== '-'",
  "        ? row.seller_personagem_nome",
  "        : (row.seller_nome || row.seller_display_name || 'Personagem');",
  "    return {",
  "        id: row.seller_id || null,",
  "        name,",
  "        displayName: row.seller_display_name || null,",
  "        imagePath: row.seller_site_profile_image_data || row.seller_personagem_aparencia_image_path || null,",
  "        squad: row.seller_esquadrao || '-',",
  "        patent: row.seller_patente || '-',",
  "    };",
  "}",
  "",
  "async function getMarketSellerProjection(db, alias = 'seller') {",
  "    const columns = new Set((await db.all('PRAGMA table_info(jogadores)')).map((row) => row.name));",
  "    const column = (name, result) => columns.has(name)",
  "        ? alias + '.' + name + ' AS ' + result",
  "        : 'NULL AS ' + result;",
  "    return [",
  "        column('personagem_nome', 'seller_personagem_nome'),",
  "        column('nome', 'seller_nome'),",
  "        column('display_name', 'seller_display_name'),",
  "        column('site_profile_image_data', 'seller_site_profile_image_data'),",
  "        column('personagem_aparencia_image_path', 'seller_personagem_aparencia_image_path'),",
  "        column('esquadrao', 'seller_esquadrao'),",
  "        column('patente', 'seller_patente'),",
  "    ].join(',\\n                ');",
  "}",
  "",
].join("\n");

service = replaceOnce(
  service,
  "function serializeListing(row) {",
  sellerHelpers + "function serializeListing(row) {",
  "helpers do vendedor",
);

service = replaceOnce(
  service,
  "    const metadata = safeJsonParse(row.metadata_json, {});\n    return {",
  [
    "    const metadata = safeJsonParse(row.metadata_json, {});",
    "    const itemProperties = safeJsonParse(row.item_properties_json, {});",
    "    const itemMetadata = safeJsonParse(row.item_metadata_json, {});",
    "    const seller = serializeMarketSeller(row);",
    "    const itemImage = itemProperties.image || itemProperties.imagem || itemProperties.image_url || itemProperties.imageUrl",
    "        || itemMetadata.image || itemMetadata.imagem || itemMetadata.image_url || itemMetadata.imageUrl || null;",
    "    return {",
  ].join("\n"),
  "dados visuais do anúncio",
);

service = replaceOnce(
  service,
  "        description: row.item_description || null,\n        quality: row.item_quality || null,",
  "        description: row.item_description || null,\n        image: itemImage,\n        quality: row.item_quality || null,",
  "imagem do item",
);

service = replaceOnce(
  service,
  "        createdAt: row.created_at,\n        metadata,",
  "        createdAt: row.created_at,\n        seller,\n        shopName: 'Banca de ' + seller.name,\n        metadata,",
  "identidade serializada",
);

service = replaceOnce(
  service,
  "async function getListingRow(db, listingKey) {\n    const row = await db.get(",
  "async function getListingRow(db, listingKey) {\n    const sellerProjection = await getMarketSellerProjection(db);\n    const row = await db.get(",
  "projeção no detalhe",
);

service = replaceAfter(
  service,
  "async function getListingRow(db, listingKey)",
  "`SELECT listing.*, item.item_name, item.description AS item_description,\n                item.quality AS item_quality, item.durability_current, item.durability_max,",
  [
    "`SELECT listing.*, item.item_name, item.description AS item_description,",
    "                item.quality AS item_quality, item.durability_current, item.durability_max,",
    "                item.properties_json AS item_properties_json, item.metadata_json AS item_metadata_json,",
    "                ${sellerProjection},",
  ].join("\n"),
  "campos do detalhe",
);

service = replaceAfter(
  service,
  "async function getListingRow(db, listingKey)",
  "         LEFT JOIN clover_inventory_items item ON item.id = listing.inventory_item_id\n         WHERE listing.listing_key",
  "         LEFT JOIN clover_inventory_items item ON item.id = listing.inventory_item_id\n         LEFT JOIN jogadores seller ON seller.id = listing.seller_id\n         WHERE listing.listing_key",
  "join do detalhe",
);

service = replaceOnce(
  service,
  "async function listMarket(db, actorId, options = {}) {\n    await ensureMarketV1(db);\n    const type",
  "async function listMarket(db, actorId, options = {}) {\n    await ensureMarketV1(db);\n    const sellerProjection = await getMarketSellerProjection(db);\n    const type",
  "projeção na lista",
);

service = replaceAfter(
  service,
  "async function listMarket(db, actorId, options = {})",
  "`SELECT listing.*, item.item_name, item.description AS item_description,\n                item.quality AS item_quality, item.durability_current, item.durability_max,",
  [
    "`SELECT listing.*, item.item_name, item.description AS item_description,",
    "                item.quality AS item_quality, item.durability_current, item.durability_max,",
    "                item.properties_json AS item_properties_json, item.metadata_json AS item_metadata_json,",
    "                ${sellerProjection},",
  ].join("\n"),
  "campos da lista",
);

service = replaceAfter(
  service,
  "async function listMarket(db, actorId, options = {})",
  "         LEFT JOIN clover_inventory_items item ON item.id = listing.inventory_item_id\n         WHERE (? IS NULL",
  "         LEFT JOIN clover_inventory_items item ON item.id = listing.inventory_item_id\n         LEFT JOIN jogadores seller ON seller.id = listing.seller_id\n         WHERE (? IS NULL",
  "join da lista",
);

tests = replaceOnce(
  tests,
  "    quoteMarketListing,\n} = require('../helpers/clover/marketService');",
  "    quoteMarketListing,\n    listMarket,\n} = require('../helpers/clover/marketService');",
  "import do listMarket",
);

tests = replaceOnce(
  tests,
  "            patente TEXT DEFAULT 'Júnior 2ª Classe', dinheiro INTEGER DEFAULT 0",
  "            patente TEXT DEFAULT 'Júnior 2ª Classe', dinheiro INTEGER DEFAULT 0,\n            site_profile_image_data TEXT DEFAULT NULL, personagem_aparencia_image_path TEXT DEFAULT NULL",
  "colunas visuais no teste",
);

tests = replaceOnce(
  tests,
  "        await db.run('INSERT INTO jogadores (id, personagem_nome, dinheiro) VALUES (?, ?, 10000)', [id, name]);",
  [
    "        await db.run(",
    "            'INSERT INTO jogadores (id, personagem_nome, dinheiro, patente, esquadrao, site_profile_image_data) VALUES (?, ?, 10000, ?, ?, ?)',",
    "            [id, name, id === SELLER ? 'Sênior 1ª Classe' : 'Júnior 2ª Classe', id === SELLER ? 'Touros Negros' : 'Coringas Magenta', id === SELLER ? 'data:image/png;base64,c2VsbGVy' : null]",
    "        );",
  ].join("\n"),
  "identidade no teste",
);

tests = replaceOnce(
  tests,
  "    assert.equal(listing.listing.title, 'Kit pronto para missão');\n    assert.ok(listing.listing.itemName);",
  [
    "    assert.equal(listing.listing.title, 'Kit pronto para missão');",
    "    assert.equal(listing.listing.seller.name, 'Vendedor');",
    "    assert.equal(listing.listing.seller.patent, 'Sênior 1ª Classe');",
    "    assert.equal(listing.listing.seller.squad, 'Touros Negros');",
    "    assert.equal(listing.listing.seller.imagePath, 'data:image/png;base64,c2VsbGVy');",
    "    assert.equal(listing.listing.shopName, 'Banca de Vendedor');",
    "    assert.ok(listing.listing.itemName);",
  ].join("\n"),
  "asserções do detalhe",
);

tests = replaceOnce(
  tests,
  "    assert.equal((await getYullsSummary(db, SELLER)).total, 9900);\n    const preview = await previewMarketPurchase",
  [
    "    assert.equal((await getYullsSummary(db, SELLER)).total, 9900);",
    "    const publicListings = await listMarket(db, BUYER, { type: 'fixed' });",
    "    assert.equal(publicListings[0].seller.name, 'Vendedor');",
    "    assert.equal(publicListings[0].shopName, 'Banca de Vendedor');",
    "    const preview = await previewMarketPurchase",
  ].join("\n"),
  "asserções da lista",
);

fs.writeFileSync(servicePath, service);
fs.writeFileSync(testPath, tests);
console.log("Identidade do vendedor aplicada ao mercado.");
