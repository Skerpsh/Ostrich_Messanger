import { db } from "./database.js";
import { hasOpenSocket } from "./realtime.js";

// Push notifications to the mobile apps through Expo's push service.
// Messages are end-to-end encrypted, so the notification only says that
// there is a new message; the app shows the text once opened.
const EXPO_PUSH_URL =
  process.env.EXPO_PUSH_URL || "https://exp.host/--/api/v2/push/send";

// Optional: an access token if "enhanced push security" is turned on for
// the project at expo.dev.
const EXPO_ACCESS_TOKEN = process.env.EXPO_ACCESS_TOKEN;

export const PUSH_TOKEN_PATTERN = "^(Exponent|Expo)PushToken\\[[A-Za-z0-9_-]{10,100}\\]$";

let log: { error: (...args: unknown[]) => void } = console;

export function setPushLogger(logger: typeof log) {
  log = logger;
}

type PushTicket = {
  status: "ok" | "error";
  details?: { error?: string };
};

async function send(messages: { to: string; [key: string]: unknown }[]) {
  // Expo accepts up to 100 messages per request.
  for (let i = 0; i < messages.length; i += 100) {
    const batch = messages.slice(i, i + 100);

    const response = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${EXPO_ACCESS_TOKEN}` } : {}),
      },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(10_000),
    });

    const result = (await response.json().catch(() => null)) as {
      data?: PushTicket[];
    } | null;

    // Uninstalled apps: forget their tokens.
    const gone = (result?.data ?? [])
      .map((ticket, index) =>
        ticket.details?.error === "DeviceNotRegistered" ? batch[index].to : null,
      )
      .filter((token): token is string => token !== null);

    if (gone.length > 0) {
      await db.query("DELETE FROM push_tokens WHERE token = ANY($1)", [gone]);
    }
  }
}

// After a new message: notify the other member's devices that do not
// have the app open, unless they muted the chat.
export function notifyNewMessage(chatId: string, senderId: string) {
  (async () => {
    const result = await db.query(
      `
      SELECT push_tokens.token, sessions.token_hash
      FROM chat_members
      JOIN sessions ON sessions.user_id = chat_members.user_id
                   AND sessions.expires_at > NOW()
      JOIN push_tokens ON push_tokens.session_id = sessions.id
      WHERE chat_members.chat_id = $1
        AND chat_members.user_id <> $2
        AND NOT chat_members.muted
      `,
      [chatId, senderId],
    );

    const messages = result.rows
      .filter((row) => !hasOpenSocket(row.token_hash))
      .map((row) => ({
        to: row.token,
        title: "Ostrich",
        body: "New message",
        sound: "default",
        priority: "high",
        data: { chatId },
      }));

    if (messages.length > 0) {
      await send(messages);
    }
  })().catch((error) => log.error(error, "failed to send push notifications"));
}
