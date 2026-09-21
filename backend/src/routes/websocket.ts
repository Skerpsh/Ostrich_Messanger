import { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import type { WebSocket } from "ws";
import { db } from "../database.js";

type AuthenticatedSocket = WebSocket & {
  userId?: string;
  username?: string;
};

const chatSockets = new Map<string, Set<AuthenticatedSocket>>();

export default async function websocketRoutes(server: FastifyInstance) {
  server.get(
    "/ws",
    { websocket: true },
    async (socket, request) => {
      const { token } = request.query as {
        token?: string;
      };

      if (!token) {
        socket.close(1008, "Token required");
        return;
      }

      const tokenHash = crypto
        .createHash("sha256")
        .update(token)
        .digest("hex");

      const userResult = await db.query(
        `
        SELECT
          users.id,
          users.username
        FROM sessions
        JOIN users ON users.id = sessions.user_id
        WHERE sessions.token_hash = $1
          AND sessions.expires_at > NOW()
        `,
        [tokenHash],
      );

      if (userResult.rows.length === 0) {
        socket.close(1008, "Invalid or expired token");
        return;
      }

      const user = userResult.rows[0] as {
        id: string;
        username: string;
      };

      const ws = socket as AuthenticatedSocket;

      ws.userId = user.id;
      ws.username = user.username;

      socket.send(
        JSON.stringify({
          type: "connected",
          username: user.username,
        }),
      );

      socket.on("message", async (raw) => {
        try {
          const data = JSON.parse(raw.toString());

          if (data.type === "join") {
            const chatId = data.chatId as string;

            const membership = await db.query(
              `
              SELECT 1
              FROM chat_members
              WHERE chat_id = $1
                AND user_id = $2
              `,
              [chatId, user.id],
            );

            if (membership.rows.length === 0) {
              socket.send(
                JSON.stringify({
                  type: "error",
                  error: "You are not a member of this chat",
                }),
              );
              return;
            }

            if (!chatSockets.has(chatId)) {
              chatSockets.set(chatId, new Set());
            }

            chatSockets.get(chatId)!.add(ws);

            socket.send(
              JSON.stringify({
                type: "joined",
                chatId,
              }),
            );

            return;
          }

          if (data.type === "message") {
            const chatId = data.chatId as string;
            const content = data.content as string;

            if (!chatId || !content || content.trim().length === 0) {
              socket.send(
                JSON.stringify({
                  type: "error",
                  error: "chatId and content are required",
                }),
              );
              return;
            }

            const membership = await db.query(
              `
              SELECT 1
              FROM chat_members
              WHERE chat_id = $1
                AND user_id = $2
              `,
              [chatId, user.id],
            );

            if (membership.rows.length === 0) {
              socket.send(
                JSON.stringify({
                  type: "error",
                  error: "You are not a member of this chat",
                }),
              );
              return;
            }

            const result = await db.query(
              `
              INSERT INTO messages (
                chat_id,
                sender_id,
                content
              )
              VALUES ($1, $2, $3)
              RETURNING
                id,
                chat_id,
                sender_id,
                content,
                created_at
              `,
              [chatId, user.id, content.trim()],
            );

            await db.query(
              `
              UPDATE chats
              SET updated_at = NOW()
              WHERE id = $1
              `,
              [chatId],
            );

            const message = {
              type: "message",
              message: {
                ...result.rows[0],
                sender_username: user.username,
              },
            };

            const sockets = chatSockets.get(chatId);

            if (sockets) {
              for (const client of sockets) {
                if (client.readyState === 1) {
                  client.send(JSON.stringify(message));
                }
              }
            }

            return;
          }

          socket.send(
            JSON.stringify({
              type: "error",
              error: "Unknown message type",
            }),
          );
        } catch {
          socket.send(
            JSON.stringify({
              type: "error",
              error: "Invalid JSON",
            }),
          );
        }
      });

      socket.on("close", () => {
        for (const [chatId, sockets] of chatSockets) {
          sockets.delete(ws);

          if (sockets.size === 0) {
            chatSockets.delete(chatId);
          }
        }
      });
    },
  );
}
