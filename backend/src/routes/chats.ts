import { FastifyInstance } from "fastify";
import { db } from "../database.js";
import { authenticate } from "../middleware/auth.js";

export default async function chatsRoutes(server: FastifyInstance) {
  server.post(
  "/api/chats",
  {
    preHandler: authenticate,
  },
  async (request, reply) => {
    const body = request.body as {
      login_id?: string;
    };

    const { login_id } = body;

    if (!login_id) {
      return reply.status(400).send({
        error: "login_id is required",
      });
    }

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

    const existingChat = await db.query(
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
        AND (
          SELECT COUNT(*)
          FROM chat_members
          WHERE chat_members.chat_id = chats.id
        ) = 2
      LIMIT 1
      `,
      [request.user.id, otherUser.id],
    );

    if (existingChat.rows.length > 0) {
      return reply.send({
        chat: existingChat.rows[0],
        user: {
          id: otherUser.id,
          login_id: otherUser.login_id,
          username: otherUser.username,
        },
      });
    }

    const chatResult = await db.query(
      `
      INSERT INTO chats (type)
      VALUES ('direct')
      RETURNING id, type, created_at
      `,
    );

    const chat = chatResult.rows[0];

    await db.query(
      `
      INSERT INTO chat_members (chat_id, user_id)
      VALUES ($1, $2), ($1, $3)
      `,
      [chat.id, request.user.id, otherUser.id],
    );

    return reply.status(201).send({
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
      ORDER BY chats.updated_at DESC
      `,
      [request.user.id],
    );

    return {
      chats: result.rows,
    };
  },
);
}
