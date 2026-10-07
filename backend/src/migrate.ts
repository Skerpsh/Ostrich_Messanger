import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { db } from "./database.js";

// Applies the numbered SQL files in migrations/ (001_*.sql, 002_*.sql, ...)
// that have not been applied yet, in order, each in its own transaction.
// Applied migrations are recorded in schema_migrations; a file is never
// run twice, so migrations may rename, drop and move data.
//
// migrations/ lives in the backend root, one level above both src/ and dist/.
const migrationsDir = path.join(__dirname, "..", "migrations");

const MIGRATION_FILE = /^(\d+)_[\w-]+\.sql$/;

// Two deploys at once must not apply the same migration twice.
const LOCK_ID = 7_301_884;

async function migrate() {
  const client = await db.connect();

  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const applied = new Set(
      (await client.query("SELECT version FROM schema_migrations")).rows.map(
        (row) => row.version as string,
      ),
    );

    const files = (await readdir(migrationsDir))
      .filter((file) => MIGRATION_FILE.test(file))
      .sort();

    let count = 0;

    for (const file of files) {
      const version = file.replace(/\.sql$/, "");

      if (applied.has(version)) {
        continue;
      }

      const sql = await readFile(path.join(migrationsDir, file), "utf8");

      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [
          version,
        ]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw new Error(`${file}: ${error instanceof Error ? error.message : error}`);
      }

      console.log(`Applied ${file}`);
      count++;
    }

    console.log(
      count === 0
        ? "Database schema is up to date"
        : `Database schema is up to date (${count} migration${count === 1 ? "" : "s"} applied)`,
    );
  } catch (error) {
    console.error("Migration failed:", error);
    process.exitCode = 1;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => {});
    client.release();
    await db.end();
  }
}

migrate();
