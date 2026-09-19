import "dotenv/config";
import { Pool } from "pg";

export const db = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || "ostrich_db",
  user: process.env.DB_USER || "ostrich",
  password: process.env.DB_PASSWORD,
});

db.on("connect", () => {
  console.log("PostgreSQL connected");
});

db.on("error", (error) => {
  console.error("PostgreSQL error:", error);
});
