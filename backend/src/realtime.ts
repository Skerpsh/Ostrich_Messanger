import type { FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";
import { db } from "./database.js";

// All realtime state is kept in memory, so the backend must run as a
// single process.

// Sockets subscribed to each chat (receive its messages).
const chatSockets = new Map<string, Set<WebSocket>>();

// Open sockets of each connected user. A user is online while they have
// at least one.
const userSockets = new Map<string, Set<WebSocket>>();

// Users whose last socket closed recently. They are reported offline only
// after a grace period, so quick reconnects do not flicker.
const OFFLINE_GRACE_MS = 5_000;
const offlineTimers = new Map<string, NodeJS.Timeout>();

export type PresenceEvent = {
  type: "presence";
  userId: string;
  online: boolean;
  lastSeenAt: Date | null;
};

let log: FastifyBaseLogger | Console = console;

export function setRealtimeLogger(logger: FastifyBaseLogger) {
  log = logger;
}

function send(socket: WebSocket, data: string) {
  if (socket.readyState === socket.OPEN) {
    socket.send(data);
  }
}

// --- chat subscriptions ---

export function subscribe(chatId: string, socket: WebSocket) {
  let sockets = chatSockets.get(chatId);

  if (!sockets) {
    sockets = new Set();
    chatSockets.set(chatId, sockets);
  }

  sockets.add(socket);
}

export function unsubscribe(chatId: string, socket: WebSocket) {
  const sockets = chatSockets.get(chatId);

  if (!sockets) {
    return;
  }

  sockets.delete(socket);

  if (sockets.size === 0) {
    chatSockets.delete(chatId);
  }
}

export function unsubscribeAll(socket: WebSocket) {
  for (const chatId of [...chatSockets.keys()]) {
    unsubscribe(chatId, socket);
  }
}

export function broadcast(chatId: string, payload: unknown) {
  const sockets = chatSockets.get(chatId);

  if (!sockets) {
    return;
  }

  const data = JSON.stringify(payload);

  for (const socket of sockets) {
    send(socket, data);
  }
}

// --- sessions ---

// Open sockets of each session (by token hash), closed on logout.
const sessionSockets = new Map<string, Set<WebSocket>>();

// Close code for sockets of a session that has ended.
export const SESSION_ENDED_CLOSE_CODE = 4001;

export function trackSession(tokenHash: string, socket: WebSocket) {
  let sockets = sessionSockets.get(tokenHash);

  if (!sockets) {
    sockets = new Set();
    sessionSockets.set(tokenHash, sockets);
  }

  sockets.add(socket);
}

export function untrackSession(tokenHash: string, socket: WebSocket) {
  const sockets = sessionSockets.get(tokenHash);

  if (!sockets) {
    return;
  }

  sockets.delete(socket);

  if (sockets.size === 0) {
    sessionSockets.delete(tokenHash);
  }
}

export function closeSession(tokenHash: string) {
  for (const socket of sessionSockets.get(tokenHash) ?? []) {
    socket.close(SESSION_ENDED_CLOSE_CODE, "Session ended");
  }
}

// --- presence ---

export function isOnline(userId: string) {
  return userSockets.has(userId) || offlineTimers.has(userId);
}

function sendToUser(userId: string, data: string) {
  for (const socket of userSockets.get(userId) ?? []) {
    send(socket, data);
  }
}

// Presence is visible only to users who share a chat with the user.
async function notifyPeers(event: PresenceEvent) {
  const result = await db.query(
    `
    SELECT DISTINCT other.user_id
    FROM chat_members me
    JOIN chat_members other
      ON other.chat_id = me.chat_id
     AND other.user_id <> me.user_id
    WHERE me.user_id = $1
    `,
    [event.userId],
  );

  const data = JSON.stringify(event);

  for (const row of result.rows) {
    sendToUser(row.user_id, data);
  }
}

export function userConnected(userId: string, socket: WebSocket) {
  const pendingOffline = offlineTimers.get(userId);
  const wasOnline = isOnline(userId);

  if (pendingOffline) {
    clearTimeout(pendingOffline);
    offlineTimers.delete(userId);
  }

  let sockets = userSockets.get(userId);

  if (!sockets) {
    sockets = new Set();
    userSockets.set(userId, sockets);
  }

  sockets.add(socket);

  if (!wasOnline) {
    notifyPeers({
      type: "presence",
      userId,
      online: true,
      lastSeenAt: null,
    }).catch((error) => log.error(error, "failed to send presence"));
  }
}

export function userDisconnected(userId: string, socket: WebSocket) {
  const sockets = userSockets.get(userId);

  if (!sockets) {
    return;
  }

  sockets.delete(socket);

  if (sockets.size > 0) {
    return;
  }

  userSockets.delete(userId);

  offlineTimers.set(
    userId,
    setTimeout(() => {
      offlineTimers.delete(userId);
      goOffline(userId).catch((error) =>
        log.error(error, "failed to update presence"),
      );
    }, OFFLINE_GRACE_MS),
  );
}

async function goOffline(userId: string) {
  const result = await db.query(
    `
    UPDATE users
    SET last_seen_at = NOW()
    WHERE id = $1
    RETURNING last_seen_at
    `,
    [userId],
  );

  await notifyPeers({
    type: "presence",
    userId,
    online: false,
    lastSeenAt: result.rows[0]?.last_seen_at ?? new Date(),
  });
}

// Presence of the other members of a chat, sent to a client that joins it.
export async function chatPresence(
  chatId: string,
  userId: string,
): Promise<PresenceEvent[]> {
  const result = await db.query(
    `
    SELECT users.id, users.last_seen_at
    FROM chat_members
    JOIN users ON users.id = chat_members.user_id
    WHERE chat_members.chat_id = $1
      AND chat_members.user_id <> $2
    `,
    [chatId, userId],
  );

  return result.rows.map((row) => ({
    type: "presence",
    userId: row.id,
    online: isOnline(row.id),
    lastSeenAt: row.last_seen_at,
  }));
}

// On shutdown: remember when everyone connected was last seen.
export async function saveLastSeenForAll() {
  const userIds = [
    ...new Set([...userSockets.keys(), ...offlineTimers.keys()]),
  ];

  for (const timer of offlineTimers.values()) {
    clearTimeout(timer);
  }

  offlineTimers.clear();

  if (userIds.length > 0) {
    await db.query(
      "UPDATE users SET last_seen_at = NOW() WHERE id = ANY($1::uuid[])",
      [userIds],
    );
  }
}
