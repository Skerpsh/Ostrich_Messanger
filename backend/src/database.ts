import "dotenv/config";
import { Pool, PoolClient } from "pg";

export const db = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || "ostrich_db",
  user: process.env.DB_USER || "ostrich",
  password: process.env.DB_PASSWORD,
});

db.on("error", (error) => {
  // Errors of idle clients (e.g. the database restarted). Without this
  // listener they would crash the process.
  console.error("PostgreSQL error:", error);
});

// PostgreSQL error codes used by the routes.
export const PG_UNIQUE_VIOLATION = "23505";
export const PG_INVALID_TEXT = "22P02";

export function isPgError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === code
  );
}

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();

  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function isChatMember(
  chatId: string,
  userId: string,
): Promise<boolean> {
  const result = await db.query(
    `
    SELECT 1
    FROM chat_members
    WHERE chat_id = $1
      AND user_id = $2
    `,
    [chatId, userId],
  );

  return result.rows.length > 0;
}
