import { FastifyInstance } from "fastify";
import { db } from "../database.js";
import { authenticate } from "../middleware/auth.js";

export default async function messagesRoutes(server: FastifyInstance) {
  // SEND MESSAGE
  server.post(
    "/api/chats/:chatId/messages",
    {
      preHandler: authenticate,
    },
    async (request, reply) => {
      const { chatId } = request.params as {
        chatId: string;
      };

      const body = request.body as {
        content?: string;
      };

      const { content } = body;

      if (!content || content.trim().length === 0) {
        return reply.status(400).send({
          error: "Message content is required",
        });
      }

      const membership = await db.query(
        `
        SELECT 1
        FROM chat_members
        WHERE chat_id = $1
          AND user_id = $2
        `,
        [chatId, request.user.id],
      );

      if (membership.rows.length === 0) {
        return reply.status(403).send({
          error: "You are not a member of this chat",
        });
      }

      const result = await db.query(
        `
        INSERT INTO messages (
          chat_id,
          sender_id,
          content
        )
        VALUES ($1, $2, $3)
        RETURNING id, chat_id, sender_id, content, created_at
        `,
        [chatId, request.user.id, content.trim()],
      );

      await db.query(
        `
        UPDATE chats
        SET updated_at = NOW()
        WHERE id = $1
        `,
        [chatId],
      );

      return reply.status(201).send({
        message: result.rows[0],
      });
    },
  );

  // GET MESSAGES
  server.get(
    "/api/chats/:chatId/messages",
    {
      preHandler: authenticate,
    },
    async (request, reply) => {
      const { chatId } = request.params as {
        chatId: string;
      };

      const membership = await db.query(
        `
        SELECT 1
        FROM chat_members
        WHERE chat_id = $1
          AND user_id = $2
        `,
        [chatId, request.user.id],
      );

      if (membership.rows.length === 0) {
        return reply.status(403).send({
          error: "You are not a member of this chat",
        });
      }

      const result = await db.query(
        `
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
        ORDER BY messages.created_at ASC
        `,
        [chatId],
      );

      return reply.send({
        messages: result.rows,
      });
    },
  );
}
