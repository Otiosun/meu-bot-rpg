const sqlite3 = require("sqlite3");
const { open } = require("sqlite");
const fs = require("fs");
const path = require("path");

const databases = ["banco.sqlite", "database.db"];
const outputDir = path.join(process.cwd(), "artifacts", "auditoria-inventario-grimorio");

function sanitizeSql(sql) {
  return String(sql || "")
    .replace(/\s+/g, " ")
    .trim();
}

async function auditDatabase(filename) {
  const fullPath = path.join(process.cwd(), filename);

  if (!fs.existsSync(fullPath)) {
    return {
      filename,
      exists: false
    };
  }

  const stats = fs.statSync(fullPath);

  const db = await open({
    filename: fullPath,
    driver: sqlite3.Database,
    mode: sqlite3.OPEN_READONLY
  });

  try {
    const integrity = await db.get("PRAGMA integrity_check");

    const tables = await db.all(`
      SELECT name, sql
      FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `);

    const result = {
      filename,
      exists: true,
      sizeBytes: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      integrity,
      tables: []
    };

    for (const table of tables) {
      const escaped = table.name.replace(/"/g, '""');

      let count = null;
      let columns = [];
      let foreignKeys = [];
      let indexes = [];
      let error = null;

      try {
        const row = await db.get(`SELECT COUNT(*) AS total FROM "${escaped}"`);
        count = row?.total ?? null;

        columns = await db.all(`PRAGMA table_info("${escaped}")`);
        foreignKeys = await db.all(`PRAGMA foreign_key_list("${escaped}")`);
        indexes = await db.all(`PRAGMA index_list("${escaped}")`);
      } catch (err) {
        error = err.message;
      }

      result.tables.push({
        name: table.name,
        rowCount: count,
        schema: sanitizeSql(table.sql),
        columns: columns.map((column) => ({
          name: column.name,
          type: column.type,
          notNull: Boolean(column.notnull),
          defaultValue: column.dflt_value,
          primaryKeyPosition: column.pk
        })),
        foreignKeys,
        indexes,
        error
      });
    }

    return result;
  } finally {
    await db.close();
  }
}

(async () => {
  fs.mkdirSync(outputDir, { recursive: true });

  const result = {
    generatedAt: new Date().toISOString(),
    mode: "read-only",
    databases: []
  };

  for (const filename of databases) {
    result.databases.push(await auditDatabase(filename));
  }

  const outputPath = path.join(outputDir, "mapa-bancos.json");

  fs.writeFileSync(
    outputPath,
    JSON.stringify(result, null, 2),
    "utf8"
  );

  console.log("");
  console.log("Auditoria concluída sem alterar os bancos.");
  console.log(`Arquivo gerado: ${outputPath}`);
  console.log("");

  for (const database of result.databases) {
    console.log(`=== ${database.filename} ===`);

    if (!database.exists) {
      console.log("Arquivo inexistente.");
      continue;
    }

    console.log(`Tabelas: ${database.tables.length}`);

    for (const table of database.tables) {
      console.log(`${table.name}: ${table.rowCount} registros`);
    }

    console.log("");
  }
})().catch((error) => {
  console.error("Falha na auditoria:", error);
  process.exitCode = 1;
});
