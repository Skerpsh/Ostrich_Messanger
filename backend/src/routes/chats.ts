import { FastifyInstance } from "fastify";
import { PROFILE_COLUMNS, usernameSchema } from "../accounts.js";
import { db, withTransaction } from "../database.js";
import { authenticate } from "../middleware/auth.js";
import { isOnline } from "../realtime.js";

const createChatRateLimit = {
  rateLimit: {
    max: 30,
    timeWindow: "1 minute",
  },
};

export default async function chatsRoutes(server: FastifyInstance) {
  // CREATE (or return the existing) direct chat with a user, found by
  // their exact @username
  server.post<{ Body: { username: string } }>(
    "/api/chats",
    {
      preHandler: authenticate,
      config: createChatRateLimit,
      schema: {
        body: {
          type: "object",
          required: ["username"],
          properties: {
            username: usernameSchema,
          },
        },
      },
    },
    async (request, reply) => {
      const { username } = request.body;

      const targetUser = await db.query(
        `
        SELECT id, username, last_seen_at, ${PROFILE_COLUMNS}
        FROM users
        WHERE LOWER(username) = LOWER($1)
        `,
        [username],
      );

      if (targetUser.rows.length === 0) {
        return reply.status(404).send({
          error: "User not found",
        });
      }

      const otherUser = targetUser.rows[0];

      if (otherUser.id === request.user.id) {
        return reply.status(400).send({
          error: "You cannot create a chat with yourself",
        });
      }

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
          username: otherUser.username,
          avatar_id: otherUser.avatar_id,
          is_developer: otherUser.is_developer,
          last_seen_at: otherUser.last_seen_at,
          online: isOnline(otherUser.id),
        },
      });
    },
  );

  // LIST the user's chats, most recently active first, with the other
  // user's presence
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
          users.username,
          users.last_seen_at,
          ${PROFILE_COLUMNS},
          other_member.last_read_at AS peer_last_read_at,
          last_message.id AS last_message_id,
          last_message.sender_id AS last_message_sender_id,
          last_message.content AS last_message_content,
          last_message.created_at AS last_message_created_at,
          (
            SELECT COUNT(*)::int
            FROM messages
            WHERE messages.chat_id = chats.id
              AND messages.sender_id <> $1
              AND messages.created_at > chat_members.last_read_at
          ) AS unread_count
        FROM chats
        JOIN chat_members
          ON chat_members.chat_id = chats.id
        JOIN chat_members other_member
          ON other_member.chat_id = chats.id
         AND other_member.user_id <> $1
        JOIN users
          ON users.id = other_member.user_id
        LEFT JOIN LATERAL (
          -- Only the start is needed for the preview.
          SELECT id, sender_id, LEFT(content, 200) AS content, created_at
          FROM messages
          WHERE messages.chat_id = chats.id
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        ) last_message ON TRUE
        WHERE chat_members.user_id = $1
        ORDER BY chats.updated_at DESC, chats.id
        `,
        [request.user.id],
      );

      return {
        chats: result.rows.map(
          ({
            last_message_id,
            last_message_sender_id,
            last_message_content,
            last_message_created_at,
            ...chat
          }) => ({
            ...chat,
            online: isOnline(chat.user_id),
            last_message: last_message_id
              ? {
                  id: last_message_id,
                  sender_id: last_message_sender_id,
                  content: last_message_content,
                  created_at: last_message_created_at,
                }
              : null,
          }),
        ),
      };
    },
  );
}
