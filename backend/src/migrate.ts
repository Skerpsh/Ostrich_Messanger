import { readFile } from "node:fs/promises";
import path from "node:path";
import { db } from "./database.js";

// schema.sql lives in the backend root, one level above both src/ and dist/.
const schemaPath = path.join(__dirname, "..", "schema.sql");

async function migrate() {
  try {
    const schema = await readFile(schemaPath, "utf8");
    await db.query(schema);
    console.log("Database schema is up to date");
  } catch (error) {
    console.error("Migration failed:", error);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}

migrate();
