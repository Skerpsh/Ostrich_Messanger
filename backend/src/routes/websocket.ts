import { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { isChatMember } from "../database.js";
import {
  findUserByToken,
  getBearerToken,
  hashToken,
} from "../middleware/auth.js";
import {
  createMessage,
  MAX_MESSAGE_LENGTH,
  takeMessageSlot,
} from "../messages.js";
import {
  broadcast,
  chatPresence,
  saveLastSeenForAll,
  setRealtimeLogger,
  subscribe,
  trackSession,
  unsubscribe,
  unsubscribeAll,
  untrackSession,
  userConnected,
  userDisconnected,
} from "../realtime.js";

// Pings keep idle connections open behind reverse proxies (nginx closes
// connections silent for 60s by default) and detect dead clients, which
// then go offline.
const HEARTBEAT_INTERVAL_MS = 30_000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ClientMessage = {
  type?: unknown;
  chatId?: unknown;
  content?: unknown;
};

// Protocol (JSON messages):
//   client -> server: join {chatId}, leave {chatId}, message {chatId, content}
//   server -> client: connected, joined {chatId}, left {chatId},
//                     message {message}, presence {userId, online, lastSeenAt},
//                     error {error}
export default async function websocketRoutes(server: FastifyInstance) {
  setRealtimeLogger(server.log);

  const alive = new WeakMap<WebSocket, boolean>();

  const heartbeat = setInterval(() => {
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
      // from ?token= for clients that cannot set headers.
      preValidation: async (request, reply) => {
        const { token: queryToken } = request.query as { token?: string };
        const token = getBearerToken(request) ?? queryToken;

        const user = token ? await findUserByToken(token) : null;

        if (!token || !user) {
          return reply.status(401).send({
            error: "Invalid or expired token",
          });
        }

        request.user = user;
        request.token = token;
      },
    },
    (socket, request) => {
      const user = request.user;
      const tokenHash = hashToken(request.token);

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

          // The socket may have closed while the membership was checked;
          // subscribing it now would leak it (close already cleaned up).
          if (socket.readyState !== socket.OPEN) {
            return;
          }

          subscribe(chatId, socket);
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

          unsubscribe(chatId, socket);
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

          if (!takeMessageSlot(user.id)) {
            sendError("Too many messages, slow down");
            return;
          }

          const message = await createMessage(chatId, user.id, content);

          if (!message) {
            sendError("You are not a member of this chat");
            return;
          }

          broadcast(chatId, { type: "message", message });
          return;
        }

        sendError("Unknown message type");
      };

      // Client messages are handled one at a time, in the order received.
      let queue = Promise.resolve();

      alive.set(socket, true);

      socket.on("pong", () => {
        alive.set(socket, true);
      });

      socket.on("message", (raw) => {
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

        queue = queue
          .then(() => handle(data))
          .catch((error) => {
            request.log.error(error, "websocket message failed");
            sendError("Internal server error");
          });
      });

      socket.on("close", () => {
        unsubscribeAll(socket);
        untrackSession(tokenHash, socket);
        userDisconnected(user.id, socket);
      });

      trackSession(tokenHash, socket);
      userConnected(user.id, socket);

      send({
        type: "connected",
        username: user.username,
      });
    },
  );
}
