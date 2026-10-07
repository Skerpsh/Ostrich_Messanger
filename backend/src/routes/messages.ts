import { FastifyInstance } from "fastify";
import { db, isChatMember } from "../database.js";
import { authenticate } from "../middleware/auth.js";
import { createMessage, MAX_MESSAGE_LENGTH } from "../messages.js";
import { sendToChatMembers } from "../realtime.js";

const chatParamsSchema = {
  type: "object",
  required: ["chatId"],
  properties: {
    chatId: { type: "string", format: "uuid" },
  },
} as const;

// Read positions are sent while the user reads; generous, but bounded.
const readRateLimit = {
  rateLimit: {
    max: 120,
    timeWindow: "1 minute",
  },
};

// Per IP; websocket messages are limited separately.
const sendRateLimit = {
  rateLimit: {
    max: 60,
    timeWindow: "1 minute",
  },
};

type ChatParams = {
  chatId: string;
};

export default async function messagesRoutes(server: FastifyInstance) {
  // SEND MESSAGE
  server.post<{ Params: ChatParams; Body: { content: string } }>(
    "/api/chats/:chatId/messages",
    {
      preHandler: authenticate,
      config: sendRateLimit,
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
      await sendToChatMembers(chatId, {
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

      // Read positions: the user's own (where unread messages start) and
      // the other member's (which of the user's messages have been read).
      const reads = await db.query(
        `
        SELECT
          MAX(last_read_at) FILTER (WHERE user_id = $2) AS last_read_at,
          MAX(last_read_at) FILTER (WHERE user_id <> $2) AS peer_last_read_at
        FROM chat_members
        WHERE chat_id = $1
        `,
        [chatId, request.user.id],
      );

      return reply.send({
        messages: result.rows,
        last_read_at: reads.rows[0].last_read_at,
        peer_last_read_at: reads.rows[0].peer_last_read_at,
      });
    },
  );

  // MARK READ: everything up to and including the given message. Read
  // positions only move forward.
  server.post<{ Params: ChatParams; Body: { message_id: string } }>(
    "/api/chats/:chatId/read",
    {
      preHandler: authenticate,
      config: readRateLimit,
      schema: {
        params: chatParamsSchema,
        body: {
          type: "object",
          required: ["message_id"],
          properties: {
            message_id: { type: "string", format: "uuid" },
          },
        },
      },
    },
    async (request, reply) => {
      const { chatId } = request.params;

      const result = await db.query(
        `
        UPDATE chat_members
        SET last_read_at = GREATEST(chat_members.last_read_at, messages.created_at)
        FROM messages
        WHERE chat_members.chat_id = $1
          AND chat_members.user_id = $2
          AND messages.id = $3
          AND messages.chat_id = $1
        RETURNING chat_members.last_read_at
        `,
        [chatId, request.user.id, request.body.message_id],
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({
          error: "Message not found in this chat",
        });
      }

      const lastReadAt = result.rows[0].last_read_at;

      // Other devices of the user clear their unread count; the other
      // member sees their messages as read.
      await sendToChatMembers(chatId, {
        type: "read",
        chatId,
        userId: request.user.id,
        lastReadAt,
      });

      return reply.send({
        last_read_at: lastReadAt,
      });
    },
  );
}
