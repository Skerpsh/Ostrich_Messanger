import { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { isChatMember } from "../database.js";
import { findUserByToken, getBearerToken } from "../middleware/auth.js";
import { createMessage, MAX_MESSAGE_LENGTH } from "../messages.js";
import { broadcast, subscribe, unsubscribeAll } from "../realtime.js";

// Pings keep idle connections open behind reverse proxies (nginx closes
// connections silent for 60s by default) and detect dead clients.
const HEARTBEAT_INTERVAL_MS = 30_000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ClientMessage = {
  type?: unknown;
  chatId?: unknown;
  content?: unknown;
};

export default async function websocketRoutes(server: FastifyInstance) {
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

        if (!user) {
          return reply.status(401).send({
            error: "Invalid or expired token",
          });
        }

        request.user = user;
      },
    },
    (socket, request) => {
      const user = request.user;

      const send = (payload: unknown) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify(payload));
        }
      };

      const sendError = (error: string) => send({ type: "error", error });

      const handle = async (data: ClientMessage) => {
        if (data.type === "join") {
          const { chatId } = data;

          if (typeof chatId !== "string" || !UUID_RE.test(chatId)) {
            sendError("Valid chatId is required");
            return;
          }

          if (!(await isChatMember(chatId, user.id))) {
            sendError("You are not a member of this chat");
            return;
          }

          subscribe(chatId, socket);
          send({ type: "joined", chatId });
          return;
        }

        if (data.type === "message") {
          const { chatId } = data;
          const content =
            typeof data.content === "string" ? data.content.trim() : "";

          if (
            typeof chatId !== "string" ||
            !UUID_RE.test(chatId) ||
            content.length === 0
          ) {
            sendError("chatId and content are required");
            return;
          }

          if (content.length > MAX_MESSAGE_LENGTH) {
            sendError(
              `Message is too long (max ${MAX_MESSAGE_LENGTH} characters)`,
            );
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
        // Client messages are handled one at a time, in the order received.
      let queue = Promise.resolve();

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
      });

      send({
        type: "connected",
        username: user.username,
      });
    },
  );
}
