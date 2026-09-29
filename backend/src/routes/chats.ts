import { FastifyInstance } from "fastify";
import { db, withTransaction } from "../database.js";
import { authenticate } from "../middleware/auth.js";

export default async function chatsRoutes(server: FastifyInstance) {
  // CREATE (or return the existing) direct chat with a user
  server.post<{ Body: { login_id: string } }>(
    "/api/chats",
    {
      preHandler: authenticate,
      schema: {
        body: {
          type: "object",
          required: ["login_id"],
          properties: {
            login_id: { type: "string", pattern: "^[0-9]{1,18}$" },
          },
        },
      },
    },
    async (request, reply) => {
      const { login_id } = request.body;

      if (login_id === request.user.login_id) {
        return reply.status(400).send({
          error: "You cannot create a chat with yourself",
        });
      }

      const targetUser = await db.query(
        `
        SELECT id, login_id, username
        FROM users
        WHERE login_id = $1
        `,
        [login_id],
      );

      if (targetUser.rows.length === 0) {
        return reply.status(404).send({
          error: "User not found",
        });
      }

      const otherUser = targetUser.rows[0];

      const { chat, created } = await withTransaction(async (client) => {
        // Serialize creation per pair of users so two simultaneous requests
        // cannot create two direct chats between the same users.
        const pair = [request.user.id, otherUser.id].sort().join(":");

        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          pair,
        ]);

        const existingChat = await client.query(
          `
          SELECT
            chats.id,
            chats.type,
            chats.created_at
          FROM chats
          JOIN chat_members first_member
            ON first_member.chat_id = chats.id
           AND first_member.user_id = $1
          JOIN chat_members second_member
            ON second_member.chat_id = chats.id
           AND second_member.user_id = $2
          WHERE chats.type = 'direct'
          LIMIT 1
          `,
          [request.user.id, otherUser.id],
        );

        if (existingChat.rows.length > 0) {
          return { chat: existingChat.rows[0], created: false };
        }

        const chatResult = await client.query(
          `
          INSERT INTO chats (type)
          VALUES ('direct')
          RETURNING id, type, created_at
          `,
        );

        const newChat = chatResult.rows[0];

        await client.query(
          `
          INSERT INTO chat_members (chat_id, user_id)
          VALUES ($1, $2), ($1, $3)
          `,
          [newChat.id, request.user.id, otherUser.id],
        );

        return { chat: newChat, created: true };
      });

      return reply.status(created ? 201 : 200).send({
        chat: {
          id: chat.id,
          type: chat.type,
          created_at: chat.created_at,
        },
        user: {
          id: otherUser.id,
          login_id: otherUser.login_id,
          username: otherUser.username,
        },
      });
    },
  );

  // LIST the user's chats, most recently active first
  server.get(
    "/api/chats",
    {
      preHandler: authenticate,
    },
    async (request) => {
      const result = await db.query(
        `
        SELECT
          chats.id,
          chats.type,
          chats.created_at,
          chats.updated_at,
          users.id AS user_id,
          users.login_id,
          users.username
        FROM chats
        JOIN chat_members
          ON chat_members.chat_id = chats.id
        JOIN chat_members other_member
          ON other_member.chat_id = chats.id
         AND other_member.user_id <> $1
        JOIN users
          ON users.id = other_member.user_id
        WHERE chat_members.user_id = $1
        ORDER BY chats.updated_at DESC, chats.id
        `,
        [request.user.id],
      );

      return {
        chats: result.rows,
      };
    },
  );
}
