import { FastifyInstance } from "fastify";
import { PROFILE_COLUMNS, usernameSchema } from "../accounts.js";
import { db, isChatMember, withTransaction } from "../database.js";
import { authenticate } from "../middleware/auth.js";
import { isOnline, sendToChatMembers, sendToUserSockets } from "../realtime.js";

const createChatRateLimit = {
  rateLimit: {
    max: 30,
    timeWindow: "1 minute",
  },
};

const chatParamsSchema = {
  type: "object",
  required: ["chatId"],
  properties: {
    chatId: { type: "string", format: "uuid" },
  },
} as const;

// SQL: whether user `a` and user `other` have blocked each other, in
// either direction.
const BLOCKED_EITHER_WAY = (a: string, other: string) => `EXISTS (
  SELECT 1 FROM blocks
  WHERE (blocker_id = ${a} AND blocked_id = ${other})
     OR (blocker_id = ${other} AND blocked_id = ${a})
)`;

// What one user may see of another's presence: nothing if they hid it or
// one of them blocked the other.
function presenceView(row: {
  id: string;
  last_seen_at: Date | null;
  show_presence: boolean;
  blocked: boolean;
}) {
  const visible = row.show_presence && !row.blocked;

  return {
    online: visible && isOnline(row.id),
    last_seen_at: visible ? row.last_seen_at : null,
  };
}

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
        SELECT id, username, last_seen_at, show_presence, public_key,
               ${PROFILE_COLUMNS},
               ${BLOCKED_EITHER_WAY("$2::uuid", "users.id")} AS blocked,
               EXISTS (
                 SELECT 1 FROM blocks
                 WHERE blocker_id = users.id AND blocked_id = $2::uuid
               ) AS blocked_me
        FROM users
        WHERE LOWER(username) = LOWER($1)
        `,
        [username, request.user.id],
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

        // Someone who blocked you cannot be messaged in a new chat either.
        if (otherUser.blocked_me) {
          return { chat: null, created: false };
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

      if (!chat) {
        return reply.status(403).send({
          error: "You can't start a chat with this user",
        });
      }

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
          public_key: otherUser.public_key,
          ...presenceView(otherUser),
        },
      });
    },
  );

  // LIST the user's chats: pinned first, then most recently active, with
  // the other user's presence, the last message and the unread count
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
          users.show_presence,
          -- The other member's key, to encrypt for them.
          users.public_key,
          ${PROFILE_COLUMNS},
          chat_members.pinned_at IS NOT NULL AS pinned,
          chat_members.muted,
          ${BLOCKED_EITHER_WAY("$1::uuid", "users.id")} AS blocked,
          EXISTS (
            SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = users.id
          ) AS blocked_by_me,
          -- Read receipts are exchanged only if both have them on.
          CASE WHEN me.read_receipts AND users.read_receipts
            THEN other_member.last_read_at
          END AS peer_last_read_at,
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
        JOIN users me
          ON me.id = $1
        JOIN chat_members other_member
          ON other_member.chat_id = chats.id
         AND other_member.user_id <> $1
        JOIN users
          ON users.id = other_member.user_id
        LEFT JOIN LATERAL (
          -- Whole: encrypted text cannot be shortened.
          SELECT id, sender_id, content, created_at
          FROM messages
          WHERE messages.chat_id = chats.id
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        ) last_message ON TRUE
        WHERE chat_members.user_id = $1
        ORDER BY chat_members.pinned_at DESC NULLS LAST,
                 chats.updated_at DESC,
                 chats.id
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
            show_presence,
            blocked,
            ...chat
          }) => ({
            ...chat,
            ...presenceView({
              id: chat.user_id,
              last_seen_at: chat.last_seen_at,
              show_presence,
              blocked,
            }),
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

  // CHAT SETTINGS (per user): pinned to the top, muted
  server.put<{
    Params: { chatId: string };
    Body: { pinned?: boolean; muted?: boolean };
  }>(
    "/api/chats/:chatId/settings",
    {
      preHandler: authenticate,
      config: createChatRateLimit,
      schema: {
        params: chatParamsSchema,
        body: {
          type: "object",
          properties: {
            pinned: { type: "boolean" },
            muted: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      const { chatId } = request.params;
      const { pinned, muted } = request.body;

      const result = await db.query(
        `
        UPDATE chat_members
        SET pinned_at = CASE
              WHEN $3::boolean IS NULL THEN pinned_at
              WHEN $3::boolean THEN COALESCE(pinned_at, NOW())
              ELSE NULL
            END,
            muted = COALESCE($4::boolean, muted)
        WHERE chat_id = $1
          AND user_id = $2
        RETURNING pinned_at IS NOT NULL AS pinned, muted
        `,
        [chatId, request.user.id, pinned ?? null, muted ?? null],
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({
          error: "Chat not found",
        });
      }

      // The user's other devices reload their chats list.
      sendToUserSockets(request.user.id, { type: "chats_changed" });

      return result.rows[0];
    },
  );

  // DELETE CHAT: for both members, with all its messages
  server.delete<{ Params: { chatId: string } }>(
    "/api/chats/:chatId",
    {
      preHandler: authenticate,
      config: createChatRateLimit,
      schema: { params: chatParamsSchema },
    },
    async (request, reply) => {
      const { chatId } = request.params;

      if (!(await isChatMember(chatId, request.user.id))) {
        return reply.status(404).send({
          error: "Chat not found",
        });
      }

      // Tell the members while they are still members.
      await sendToChatMembers(chatId, { type: "chat_deleted", chatId });
      await db.query("DELETE FROM chats WHERE id = $1", [chatId]);

      return { deleted: true };
    },
  );
}
