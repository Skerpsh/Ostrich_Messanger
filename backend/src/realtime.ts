import type { FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";
import crypto from "node:crypto";
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

// --- sessions ---

// The session each socket was opened with, so sockets can be closed when
// their session ends (logout, password change, expiry).
type SocketSession = {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
};

const socketSessions = new Map<WebSocket, SocketSession>();

// Close code for "session ended": clients must not reconnect with the
// same token.
export const WS_CLOSE_SESSION_ENDED = 4001;

export function trackSession(socket: WebSocket, session: SocketSession) {
  socketSessions.set(socket, session);
}

export function untrackSession(socket: WebSocket) {
  socketSessions.delete(socket);
}

// Closes the sockets of the sessions matching `predicate`.
function closeSessions(predicate: (session: SocketSession) => boolean) {
  for (const [socket, session] of socketSessions) {
    if (predicate(session)) {
      socket.close(WS_CLOSE_SESSION_ENDED, "Session ended");
    }
  }
}

export function closeSessionSockets(tokenHash: string) {
  closeSessions((session) => session.tokenHash === tokenHash);
}

// Closes all sockets of the user, except those of the session `keepTokenHash`.
export function closeUserSockets(userId: string, keepTokenHash?: string) {
  closeSessions(
    (session) =>
      session.userId === userId && session.tokenHash !== keepTokenHash,
  );
}

// Closes sockets whose session has expired or no longer exists (e.g. it
// was deleted directly in the database).
export async function closeEndedSessions() {
  const now = new Date();
  closeSessions((session) => session.expiresAt <= now);

  const tokenHashes = [
    ...new Set([...socketSessions.values()].map((s) => s.tokenHash)),
  ];

  if (tokenHashes.length === 0) {
    return;
  }

  const result = await db.query(
    `
    SELECT token_hash
    FROM sessions
    WHERE token_hash = ANY($1::text[])
      AND expires_at > NOW()
    `,
    [tokenHashes],
  );

  const active = new Set(result.rows.map((row) => row.token_hash));
  closeSessions((session) => !active.has(session.tokenHash));
}

export function connectionCount(userId: string) {
  return userSockets.get(userId)?.size ?? 0;
}

// --- websocket tickets ---

// Browsers cannot set headers on websockets, so web clients pass a ticket
// in the URL instead of the session token: it is single-use and expires
// quickly, so a URL that ends up in a proxy log is useless.
const TICKET_TTL_MS = 30_000;

const tickets = new Map<string, { tokenHash: string; expiresAt: number }>();

export function createTicket(tokenHash: string): string {
  const now = Date.now();

  for (const [ticket, entry] of tickets) {
    if (entry.expiresAt <= now) {
      tickets.delete(ticket);
    }
  }

  const ticket = crypto.randomBytes(32).toString("hex");
  tickets.set(ticket, { tokenHash, expiresAt: now + TICKET_TTL_MS });

  return ticket;
}

// Returns the ticket's session token hash and invalidates the ticket.
export function consumeTicket(ticket: string): string | null {
  const entry = tickets.get(ticket);
  tickets.delete(ticket);

  if (!entry || entry.expiresAt <= Date.now()) {
    return null;
  }

  return entry.tokenHash;
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
