// Gives or takes away the "DEV" badge. Run on the server only:
//
//   npm run dev-badge:prod -- add @username
//   npm run dev-badge:prod -- remove @username
//   npm run dev-badge:prod -- list
//
// (npm run dev-badge -- ... in development.) There is deliberately no API
// for this, so the badge can only be set by someone with server access.
import { db } from "./database.js";

const USAGE = `Usage:
  dev-badge add @username      give the DEV badge
  dev-badge remove @username   take it away
  dev-badge list               show who has it`;

async function setBadge(input: string | undefined, value: boolean) {
  if (!input) {
    console.error(USAGE);
    return 1;
  }

  const username = input.replace(/^@/, "");

  const result = await db.query(
    `
    UPDATE users
    SET is_developer = $2
    WHERE LOWER(username) = LOWER($1)
    RETURNING username
    `,
    [username, value],
  );

  if (result.rows.length === 0) {
    console.error(`No user @${username}`);
    return 1;
  }

  console.log(
    `@${result.rows[0].username} ${value ? "now has" : "no longer has"} the DEV badge.`,
  );
  console.log(
    "Others see it after their chats list reloads (reopening the app or reconnecting).",
  );
  return 0;
}

async function list() {
  const result = await db.query(
    `
    SELECT username
    FROM users
    WHERE is_developer
    ORDER BY LOWER(username)
    `,
  );

  if (result.rows.length === 0) {
    console.log("Nobody has the DEV badge.");
  }

  for (const row of result.rows) {
    console.log(`@${row.username}`);
  }

  return 0;
}

async function main() {
  const [command, username] = process.argv.slice(2);

  try {
    switch (command) {
      case "add":
        return await setBadge(username, true);
      case "remove":
        return await setBadge(username, false);
      case "list":
        return await list();
      default:
        console.error(USAGE);
        return 1;
    }
  } finally {
    await db.end();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error("dev-badge failed:", error);
    process.exitCode = 1;
  },
);
