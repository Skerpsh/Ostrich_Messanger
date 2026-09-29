import { FastifyInstance } from "fastify";
import { db, isChatMember } from "../database.js";
import { authenticate } from "../middleware/auth.js";
import { createMessage, MAX_MESSAGE_LENGTH } from "../messages.js";
import { broadcast } from "../realtime.js";

const chatParamsSchema = {
  type: "object",
  required: ["chatId"],
  properties: {
    chatId: { type: "string", format: "uuid" },
  },
} as const;

type ChatParams = {
  chatId: string;
};

export default async function messagesRoutes(server: FastifyInstance) {
  // SEND MESSAGE
  server.post<{ Params: ChatParams; Body: { content: string } }>(
    "/api/chats/:chatId/messages",
    {
      preHandler: authenticate,
      schema: {
        params: chatParamsSchema,
        body: {
          type: "object",
          required: ["content"],
          properties: {
            content: {
              type: "string",
              maxLength: MAX_MESSAGE_LENGTH,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { chatId } = request.params;
      const content = request.body.content.trim();

      if (content.length === 0) {
        return reply.status(400).send({
          error: "Message content is required",
        });
      }

      const message = await createMessage(chatId, request.user.id, content);

      if (!message) {
        return reply.status(403).send({
          error: "You are not a member of this chat",
        });
      }

      // Deliver to clients connected over websocket.
      broadcast(chatId, {
        type: "message",
        message,
      });

      return reply.status(201).send({
        message,
      });
    },
  );

  // GET MESSAGES (the latest `limit` messages, oldest first)
  server.get<{ Params: ChatParams; Querystring: { limit: number } }>(
    "/api/chats/:chatId/messages",
    {
      preHandler: authenticate,
      schema: {
        params: chatParamsSchema,
        querystring: {
          type: "object",
          properties: {
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 1000,
              default: 200,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { chatId } = request.params;

      if (!(await isChatMember(chatId, request.user.id))) {
        return reply.status(403).send({
          error: "You are not a member of this chat",
        });
      }

      const result = await db.query(
        `
        SELECT *
        FROM (
          SELECT
            messages.id,
            messages.chat_id,
            messages.sender_id,
            users.username AS sender_username,
            messages.content,
            messages.created_at
          FROM messages
          JOIN users ON users.id = messages.sender_id
          WHERE messages.chat_id = $1
          ORDER BY messages.created_at DESC, messages.id DESC
          LIMIT $2
        ) latest
        ORDER BY created_at ASC, id ASC
        `,
        [chatId, request.query.limit],
      );

      return reply.send({
        messages: result.rows,
      });
    },
  );
}
