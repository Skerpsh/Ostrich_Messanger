import type { FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";
import crypto from "node:crypto";
import { db } from "./database.js";
import { sharedState, type ClusterEvent } from "./shared-state.js";
import { presenceVisible } from "./visibility.js";

// Websockets and presence. Each process has its own sockets; events go
// through the shared state (shared-state.ts: in memory, or Redis for
// several processes), and every process delivers them to its sockets.

// This process's open sockets of each connected user. A user is online
// while they have at least one on any process.
const userSockets = new Map<string, Set<WebSocket>>();

// Users whose last socket closed recently. They are reported offline only
// after a grace period, so quick reconnects do not flicker.
const OFFLINE_GRACE_MS = 5_000;
// Kept longer in the shared state than the timer that ends it, so the
// timer finds it.
const LEAVING_TTL_MS = OFFLINE_GRACE_MS * 3;
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

// Closes this process's sockets of the sessions matching `predicate`.
function closeSessions(predicate: (session: SocketSession) => boolean) {
  for (const [socket, session] of socketSessions) {
    if (predicate(session)) {
      socket.close(WS_CLOSE_SESSION_ENDED, "Session ended");
    }
  }
}

// The sessions of these that have a socket open (the app is open on that
// device), on any process.
export function sessionsWithSockets(tokenHashes: string[]) {
  return sharedState().sessionsWithSockets(tokenHashes);
}

// Commands go to every process; errors are logged, not thrown (the
// session has ended in the database either way).
function broadcast(event: ClusterEvent) {
  sharedState()
    .publish(event)
    .catch((error) => log.error(error, "failed to publish a realtime event"));
}

export function closeSessionSockets(tokenHash: string) {
  broadcast({ type: "close", tokenHash });
}

// Closes all sockets of the user, except those of the session `keepTokenHash`.
export function closeUserSockets(userId: string, keepTokenHash?: string) {
  broadcast({ type: "close", userId, keepTokenHash });
}

// Applies events from all processes to this process's sockets.
let subscribed = false;

export function listenForEvents() {
  if (subscribed) {
    return;
  }

  subscribed = true;

  sharedState().subscribe((event) => {
    switch (event.type) {
      case "deliver":
        for (const userId of event.userIds) {
          sendToUser(userId, event.data);
        }
        break;

      case "close":
        closeSessions((session) =>
          event.tokenHash !== undefined
            ? session.tokenHash === event.tokenHash
            : session.userId === event.userId && session.tokenHash !== event.keepTokenHash,
        );
        break;
    }
  });
}

// Closes sockets whose session has expired or no longer exists (e.g. it
// was deleted directly in the database). Sessions are extended while used,
// so only the database knows when one really ends.
export async function closeEndedSessions() {
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

// How many sockets the user has open, on all processes.
export async function connectionCount(userId: string) {
  return (await sharedState().socketCounts([userId])).get(userId) ?? 0;
}

// --- websocket tickets ---

// Browsers cannot set headers on websockets, so web clients pass a ticket
// in the URL instead of the session token: it is single-use and expires
// quickly, so a URL that ends up in a proxy log is useless.
const TICKET_TTL_MS = 30_000;

export async function createTicket(tokenHash: string): Promise<string> {
  const ticket = crypto.randomBytes(32).toString("hex");
  await sharedState().putTicket(ticket, tokenHash, TICKET_TTL_MS);

  return ticket;
}

// Returns the ticket's session token hash and invalidates the ticket.
export function consumeTicket(ticket: string): Promise<string | null> {
  return sharedState().takeTicket(ticket);
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

  await deliver(
    result.rows.map((row) => row.user_id).filter((id) => id !== exceptUserId),
    payload,
  );
}

// Sends to the sockets of these users on all processes.
async function deliver(userIds: string[], payload: unknown) {
  if (userIds.length > 0) {
    await sharedState().publish({ type: "deliver", userIds, data: JSON.stringify(payload) });
  }
}

// Sends to all sockets of one user (their devices).
export function sendToUserSockets(userId: string, payload: unknown) {
  deliver([userId], payload).catch((error) => log.error(error, "failed to send an event"));
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

  const recipients = new Set<string>([userId]);

  for (const row of result.rows) {
    recipients.add(row.user_id);
  }

  await deliver([...recipients], payload);
}

// --- presence ---

// The users of these that are online: with a socket open on any process,
// or gone only a moment ago.
export async function onlineUsers(userIds: string[]) {
  const unique = [...new Set(userIds)];

  if (unique.length === 0) {
    return new Set<string>();
  }

  const state = sharedState();
  const [counts, leaving] = await Promise.all([state.socketCounts(unique), state.leavingUsers(unique)]);

  return new Set(unique.filter((id) => (counts.get(id) ?? 0) > 0 || leaving.has(id)));
}

export async function isOnline(userId: string) {
  return (await onlineUsers([userId])).has(userId);
}

// Delivers to this process's sockets of the user.
function sendToUser(userId: string, data: string) {
  for (const socket of userSockets.get(userId) ?? []) {
    send(socket, data);
  }
}

// Presence is visible only to users who share a chat with the user, see
// presenceVisible().
async function notifyPeers(event: PresenceEvent) {
  const result = await db.query(
    `
    SELECT DISTINCT other.user_id
    FROM chat_members me
    JOIN users ON users.id = me.user_id
    JOIN chat_members other
      ON other.chat_id = me.chat_id
     AND other.user_id <> me.user_id
    WHERE me.user_id = $1
      AND ${presenceVisible("users", "other.user_id", "me.chat_id")}
    `,
    [event.userId],
  );

  await deliver(
    result.rows.map((row) => row.user_id),
    event,
  );
}

// The user's presence for the other members of a chat, e.g. once the user
// has written there for the first time and it becomes visible to them.
export async function announcePresence(userId: string, chatId: string) {
  const result = await db.query(
    `
    SELECT other.user_id, users.last_seen_at
    FROM chat_members other
    JOIN users ON users.id = $1
    WHERE other.chat_id = $2
      AND other.user_id <> $1
      AND ${presenceVisible("users", "other.user_id", "$2::uuid")}
    `,
    [userId, chatId],
  );

  if (result.rows.length === 0) {
    return;
  }

  const online = await isOnline(userId);

  await deliver(
    result.rows.map((row) => row.user_id),
    {
      type: "presence",
      userId,
      online,
      lastSeenAt: online ? null : result.rows[0].last_seen_at,
    } satisfies PresenceEvent,
  );
}

// Counting a socket in the shared state, per socket: its closing waits
// for its opening to be counted.
const counted = new WeakMap<WebSocket, Promise<unknown>>();

// A socket opened: online for everyone who may see it, unless the user
// was already (another device, or back within the grace period).
export function userConnected(userId: string, tokenHash: string, socket: WebSocket) {
  const pendingOffline = offlineTimers.get(userId);

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

  const state = sharedState();

  const opening = (async () => {
    const total = await state.addSocket(userId, tokenHash);
    const wasLeaving = await state.takeLeaving(userId);

    if (total === 1 && !wasLeaving) {
      await notifyPeers({ type: "presence", userId, online: true, lastSeenAt: null });
    }
  })().catch((error) => log.error(error, "failed to update presence"));

  counted.set(socket, opening);
}

// A socket closed: after the last one on all processes, and a grace
// period without a new one, the user goes offline.
export function userDisconnected(userId: string, tokenHash: string, socket: WebSocket) {
  const sockets = userSockets.get(userId);

  sockets?.delete(socket);

  if (sockets?.size === 0) {
    userSockets.delete(userId);
  }

  const state = sharedState();

  (async () => {
    await counted.get(socket);
    counted.delete(socket);

    if ((await state.removeSocket(userId, tokenHash)) > 0) {
      return;
    }

    await state.setLeaving(userId, LEAVING_TTL_MS);

    clearTimeout(offlineTimers.get(userId));
    offlineTimers.set(
      userId,
      setTimeout(() => {
        offlineTimers.delete(userId);

        // Back on another process meanwhile: it took the "leaving" mark.
        (async () => {
          if (await state.takeLeaving(userId)) {
            await goOffline(userId);
          }
        })().catch((error) => log.error(error, "failed to update presence"));
      }, OFFLINE_GRACE_MS),
    );
  })().catch((error) => log.error(error, "failed to update presence"));
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
      ${presenceVisible("users", "$2::uuid", "$1::uuid")} AS visible
    FROM chat_members
    JOIN users ON users.id = chat_members.user_id
    WHERE chat_members.chat_id = $1
      AND chat_members.user_id <> $2
    `,
    [chatId, userId],
  );

  const online = await onlineUsers(result.rows.filter((row) => row.visible).map((row) => row.id));

  return result.rows.map((row) => ({
    type: "presence",
    userId: row.id,
    online: online.has(row.id),
    lastSeenAt: row.visible ? row.last_seen_at : null,
  }));
}

// On shutdown: remember when everyone connected here was last seen, and
// take this process's sockets out of the shared state.
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

  await sharedState().close();
}
