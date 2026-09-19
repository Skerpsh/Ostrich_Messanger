import { Pool } from "pg";

export const db = new Pool({
  host: "localhost",
  port: 5432,
  database: "ostrich_db",
  user: "ostrich",
  password: "12345",
});

db.on("connect", () => {
  console.log("PostgreSQL connected");
});

db.on("error", (error) => {
  console.error("PostgreSQL error:", error);
});
