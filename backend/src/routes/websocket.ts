import { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { isChatMember } from "../database.js";
import {
  findSessionByHash,
  getBearerToken,
  hashToken,
  type Session,
} from "../middleware/auth.js";
import {
  CREATE_MESSAGE_ERRORS,
  createMessage,
  MAX_MESSAGE_LENGTH,
} from "../messages.js";
import {
  chatPresence,
  closeEndedSessions,
  connectionCount,
  consumeTicket,
  saveLastSeenForAll,
  sendToChatMembers,
  setRealtimeLogger,
  trackSession,
  untrackSession,
  userConnected,
  userDisconnected,
} from "../realtime.js";

// Pings keep idle connections open behind reverse proxies (nginx closes
// connections silent for 60s by default) and detect dead clients, which
// then go offline.
const HEARTBEAT_INTERVAL_MS = 30_000;

// Open connections per user (devices, tabs).
const MAX_CONNECTIONS_PER_USER = 10;

// Client messages per socket: at most RATE_LIMIT_MESSAGES per
// RATE_LIMIT_WINDOW_MS; more are rejected.
const RATE_LIMIT_MESSAGES = 30;
const RATE_LIMIT_WINDOW_MS = 10_000;

// Messages waiting to be handled per socket. A client that sends faster
// than the server can handle is disconnected instead of being buffered.
const MAX_PENDING_MESSAGES = 50;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ClientMessage = {
  type?: unknown;
  chatId?: unknown;
  content?: unknown;
  replyTo?: unknown;
};

// Protocol (JSON messages):
//   client -> server: join {chatId}, leave {chatId},
//                     message {chatId, content, replyTo?}
//   server -> client: connected, joined {chatId}, left {chatId},
//                     message {message}, read {chatId, userId, lastReadAt},
//                     profile {userId, username, avatarId},
//                     presence {userId, online, lastSeenAt}, error {error}
//
// "message" and "read" events of all the user's chats are sent to all their
// sockets. "join" answers with "joined" (clients reload the chat's history
// on it) and the presence of the chat's other members.
export default async function websocketRoutes(server: FastifyInstance) {
  setRealtimeLogger(server.log);

  const alive = new WeakMap<WebSocket, boolean>();

  // Session found by preValidation, handed over to the websocket handler.
  const sessions = new WeakMap<object, Session>();

  const heartbeat = setInterval(() => {
    closeEndedSessions().catch((error) =>
      server.log.error(error, "failed to check websocket sessions"),
    );

    for (const socket of server.websocketServer.clients) {
      if (alive.get(socket) === false) {
        socket.terminate();
        continue;
      }

      alive.set(socket, false);
      socket.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  server.addHook("onClose", async () => {
    clearInterval(heartbeat);
    await saveLastSeenForAll();
  });

  server.get(
    "/ws",
    {
      websocket: true,

      // Authenticate before the upgrade so unauthorized clients get a
      // plain 401. The token is taken from the Authorization header, or
      // from a ?ticket= (POST /api/auth/ws-ticket) for browsers, which
      // cannot set headers.
      preValidation: async (request, reply) => {
        const { ticket } = request.query as { ticket?: unknown };
        const token = getBearerToken(request);

        const tokenHash = token
          ? hashToken(token)
          : typeof ticket === "string"
            ? consumeTicket(ticket)
            : null;

        const session = tokenHash ? await findSessionByHash(tokenHash) : null;

        if (!session) {
          return reply.status(401).send({
            error: "Invalid or expired token",
          });
        }

        if (connectionCount(session.user.id) >= MAX_CONNECTIONS_PER_USER) {
          return reply.status(429).send({
            error: "Too many connections",
          });
        }

        request.user = session.user;
        sessions.set(request.raw, session);
      },
    },
    (socket, request) => {
      const user = request.user;
      const session = sessions.get(request.raw);
      sessions.delete(request.raw);

      if (!session) {
        socket.close(1011, "Internal server error");
        return;
      }

      const send = (payload: unknown) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify(payload));
        }
      };

      const sendError = (error: string) => send({ type: "error", error });

      const validChatId = (chatId: unknown): chatId is string =>
        typeof chatId === "string" && UUID_RE.test(chatId);

      const handle = async (data: ClientMessage) => {
        if (data.type === "join") {
          const { chatId } = data;

          if (!validChatId(chatId)) {
            sendError("Valid chatId is required");
            return;
          }

          if (!(await isChatMember(chatId, user.id))) {
            sendError("You are not a member of this chat");
            return;
          }

          send({ type: "joined", chatId });

          for (const event of await chatPresence(chatId, user.id)) {
            send(event);
          }

          return;
        }

        if (data.type === "leave") {
          const { chatId } = data;

          if (!validChatId(chatId)) {
            sendError("Valid chatId is required");
            return;
          }

          send({ type: "left", chatId });
          return;
        }

        if (data.type === "message") {
          const { chatId } = data;
          const content =
            typeof data.content === "string" ? data.content.trim() : "";

          if (!validChatId(chatId) || content.length === 0) {
            sendError("chatId and content are required");
            return;
          }

          if (content.length > MAX_MESSAGE_LENGTH) {
            sendError(
              `Message is too long (max ${MAX_MESSAGE_LENGTH} characters)`,
            );
            return;
          }

          const { replyTo } = data;

          if (replyTo != null && !validChatId(replyTo)) {
            sendError("replyTo must be a message id");
            return;
          }

          const result = await createMessage(
            chatId,
            user.id,
            content,
            replyTo ?? null,
          );

          if ("error" in result) {
            sendError(CREATE_MESSAGE_ERRORS[result.error]);
            return;
          }

          await sendToChatMembers(chatId, {
            type: "message",
            message: result.message,
          });
          return;
        }

        sendError("Unknown message type");
      };

      // Client messages are handled one at a time, in the order received.
      let queue = Promise.resolve();
      let pending = 0;

      let windowStart = Date.now();
      let windowCount = 0;

      const rateLimited = () => {
        const now = Date.now();

        if (now - windowStart >= RATE_LIMIT_WINDOW_MS) {
          windowStart = now;
          windowCount = 0;
        }

        windowCount++;

        return windowCount > RATE_LIMIT_MESSAGES;
      };

      alive.set(socket, true);

      socket.on("pong", () => {
        alive.set(socket, true);
      });

      socket.on("message", (raw) => {
        if (pending >= MAX_PENDING_MESSAGES) {
          socket.close(1008, "Too many messages");
          return;
        }

        if (rateLimited()) {
          // Clients that keep flooding are disconnected rather than sent
          // an error for every message.
          if (windowCount > RATE_LIMIT_MESSAGES * 3) {
            socket.close(1008, "Too many messages");
          } else {
            sendError("Too many messages, slow down");
          }

          return;
        }

        let data: ClientMessage;

        try {
          data = JSON.parse(raw.toString());
        } catch {
          sendError("Invalid JSON");
          return;
        }

        if (typeof data !== "object" || data === null) {
          sendError("Invalid message");
          return;
        }

        pending++;

        queue = queue
          .then(() => handle(data))
          .catch((error) => {
            request.log.error(error, "websocket message failed");
            sendError("Internal server error");
          })
          .finally(() => {
            pending--;
          });
      });

      socket.on("close", () => {
        untrackSession(socket);
        userDisconnected(user.id, socket);
      });

      trackSession(socket, {
        userId: user.id,
        tokenHash: session.tokenHash,
        expiresAt: session.expiresAt,
      });
      userConnected(user.id, socket);

      send({
        type: "connected",
        username: user.username,
      });
    },
  );
}
