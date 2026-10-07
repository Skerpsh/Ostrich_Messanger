import type { FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";
import crypto from "node:crypto";
import { db } from "./database.js";

// All realtime state is kept in memory, so the backend must run as a
// single process.

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

// Whether the session has an open socket (the app is open on that device).
export function hasOpenSocket(tokenHash: string) {
  for (const session of socketSessions.values()) {
    if (session.tokenHash === tokenHash) {
      return true;
    }
  }

  return false;
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

// --- chat events ---

// Sends to every open socket of the chat's members (all their devices),
// not only to clients that have the chat open: chat lists need new
// messages and read positions to keep last messages and unread counts
// up to date.
export async function sendToChatMembers(
  chatId: string,
  payload: unknown,
  // E.g. the typing user, who does not need their own "typing" event.
  exceptUserId?: string,
) {
  const result = await db.query(
    `
    SELECT user_id
    FROM chat_members
    WHERE chat_id = $1
    `,
    [chatId],
  );

  const data = JSON.stringify(payload);

  for (const row of result.rows) {
    if (row.user_id !== exceptUserId) {
      sendToUser(row.user_id, data);
    }
  }
}

// Sends to all sockets of one user (their devices).
export function sendToUserSockets(userId: string, payload: unknown) {
  sendToUser(userId, JSON.stringify(payload));
}

// Sends to everyone who shares a chat with the user and to the user's own
// sockets (other devices), e.g. after a profile change.
export async function sendToContacts(userId: string, payload: unknown) {
  const result = await db.query(
    `
    SELECT DISTINCT other.user_id
    FROM chat_members me
    JOIN chat_members other ON other.chat_id = me.chat_id
    WHERE me.user_id = $1
    `,
    [userId],
  );

  const data = JSON.stringify(payload);
  const recipients = new Set<string>([userId]);

  for (const row of result.rows) {
    recipients.add(row.user_id);
  }

  for (const recipient of recipients) {
    sendToUser(recipient, data);
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

// Presence is visible only to users who share a chat with the user, and
// not at all if the user hid it or to users blocked either way.
async function notifyPeers(event: PresenceEvent) {
  const result = await db.query(
    `
    SELECT DISTINCT other.user_id
    FROM chat_members me
    JOIN users self ON self.id = me.user_id
    JOIN chat_members other
      ON other.chat_id = me.chat_id
     AND other.user_id <> me.user_id
    WHERE me.user_id = $1
      AND self.show_presence
      AND NOT EXISTS (
        SELECT 1 FROM blocks
        WHERE (blocker_id = $1 AND blocked_id = other.user_id)
           OR (blocker_id = other.user_id AND blocked_id = $1)
      )
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
    SELECT
      users.id,
      users.last_seen_at,
      users.show_presence AND NOT EXISTS (
        SELECT 1 FROM blocks
        WHERE (blocker_id = $2 AND blocked_id = users.id)
           OR (blocker_id = users.id AND blocked_id = $2)
      ) AS visible
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
    online: row.visible && isOnline(row.id),
    lastSeenAt: row.visible ? row.last_seen_at : null,
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
