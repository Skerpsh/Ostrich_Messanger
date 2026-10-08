import { FastifyInstance } from "fastify";
import { AVATAR_ID_COLUMN, PROFILE_COLUMNS, usernameSchema } from "../accounts.js";
import { db, isChatMember, withTransaction } from "../database.js";
import { groupMembership, isAdmin } from "../groups.js";
import { isBlockedInChat } from "../messages.js";
import { authenticate } from "../middleware/auth.js";
import { isOnline, sendToChatMembers, sendToUserSockets } from "../realtime.js";
import { blockedEitherWay, presenceVisible } from "../visibility.js";

// Starting chats and changing them (settings, deletion).
const chatsRateLimit = {
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

// What the signed-in user may see of the other member's presence.
function presenceView(row: {
  user_id: string | null;
  last_seen_at: Date | null;
  presence_visible: boolean;
}) {
  return {
    online: row.presence_visible && row.user_id !== null && isOnline(row.user_id),
    last_seen_at: row.presence_visible ? row.last_seen_at : null,
  };
}

export default async function chatsRoutes(server: FastifyInstance) {
  // CREATE (or return the existing) direct chat with a user, found by
  // their exact @username
  server.post<{ Body: { username: string } }>(
    "/api/chats",
    {
      preHandler: authenticate,
      config: chatsRateLimit,
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
               ${blockedEitherWay("$2::uuid", "users.id")} AS blocked,
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
            chats.created_at,
            ${presenceVisible("users", "$1::uuid", "chats.id")} AS presence_visible
          FROM chats
          JOIN chat_members first_member
            ON first_member.chat_id = chats.id
           AND first_member.user_id = $1
          JOIN chat_members second_member
            ON second_member.chat_id = chats.id
           AND second_member.user_id = $2
          JOIN users ON users.id = $2
          WHERE chats.type = 'direct'
          LIMIT 1
          `,
          [request.user.id, otherUser.id],
        );

        if (existingChat.rows.length > 0) {
          // Opening it brings a hidden chat back into the list.
          await client.query(
            `
            UPDATE chat_members
            SET hidden = FALSE
            WHERE chat_id = $1
              AND user_id = $2
              AND hidden
            `,
            [existingChat.rows[0].id, request.user.id],
          );

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

        // Hidden for the other user until the first message arrives.
        await client.query(
          `
          INSERT INTO chat_members (chat_id, user_id, hidden)
          VALUES ($1, $2, FALSE), ($1, $3, TRUE)
          `,
          [newChat.id, request.user.id, otherUser.id],
        );

        // Nobody has written yet, so the presence stays hidden.
        return { chat: { ...newChat, presence_visible: false }, created: true };
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
          blocked: otherUser.blocked,
          ...presenceView({
            user_id: otherUser.id,
            last_seen_at: otherUser.last_seen_at,
            presence_visible: chat.presence_visible,
          }),
        },
      });
    },
  );

  // LIST the user's chats: pinned first, then most recently active, with
  // the last message and the unread count; for direct chats the other
  // user and their presence, for groups the encrypted name, the key epoch
  // and the user's role. Hidden chats (see migrations/002) are left out.
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
          chats.encrypted_info,
          chats.key_epoch,
          chats.rotation_needed,
          chat_members.role,
          (SELECT COUNT(*)::int FROM chat_members cm WHERE cm.chat_id = chats.id) AS member_count,
          peer.id AS user_id,
          peer.username,
          peer.last_seen_at,
          -- The other member's key, to encrypt for them.
          peer.public_key,
          peer.avatar_id,
          COALESCE(peer.is_developer, FALSE) AS is_developer,
          chat_members.pinned_at IS NOT NULL AS pinned,
          chat_members.muted,
          COALESCE(peer.presence_visible, FALSE) AS presence_visible,
          -- Either has blocked the other: no messages either way.
          COALESCE(peer.blocked, FALSE) AS blocked,
          COALESCE(peer.blocked_by_me, FALSE) AS blocked_by_me,
          -- Read receipts: only if the user has them on; in a direct chat
          -- if the other member has too, in a group up to where any member
          -- with them on has read (as Telegram shows it).
          CASE WHEN me.read_receipts THEN
            CASE WHEN chats.type = 'direct'
              THEN CASE WHEN peer.read_receipts THEN peer.last_read_at END
              ELSE (
                SELECT MAX(cm.last_read_at)
                FROM chat_members cm
                JOIN users u ON u.id = cm.user_id
                WHERE cm.chat_id = chats.id
                  AND cm.user_id <> $1
                  AND u.read_receipts
              )
            END
          END AS peer_last_read_at,
          pinned.id AS pinned_message_id,
          pinned.sender_id AS pinned_message_sender_id,
          pinned.content AS pinned_message_content,
          pinned.created_at AS pinned_message_created_at,
          last_message.id AS last_message_id,
          last_message.sender_id AS last_message_sender_id,
          last_message.sender_username AS last_message_sender_username,
          last_message.kind AS last_message_kind,
          last_message.content AS last_message_content,
          last_message.created_at AS last_message_created_at,
          (
            SELECT COUNT(*)::int
            FROM messages
            WHERE messages.chat_id = chats.id
              AND messages.sender_id <> $1
              AND messages.kind = 'text'
              AND messages.created_at > chat_members.last_read_at
          ) AS unread_count
        FROM chats
        JOIN chat_members
          ON chat_members.chat_id = chats.id
         AND chat_members.user_id = $1
        JOIN users me
          ON me.id = $1
        -- Direct chats: the other member.
        LEFT JOIN LATERAL (
          SELECT
            users.id,
            users.username,
            users.last_seen_at,
            users.public_key,
            users.is_developer,
            users.read_receipts,
            other.last_read_at,
            ${AVATAR_ID_COLUMN},
            ${presenceVisible("users", "$1::uuid", "chats.id")} AS presence_visible,
            ${blockedEitherWay("$1::uuid", "users.id")} AS blocked,
            EXISTS (
              SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = users.id
            ) AS blocked_by_me
          FROM chat_members other
          JOIN users ON users.id = other.user_id
          WHERE other.chat_id = chats.id
            AND other.user_id <> $1
            AND chats.type = 'direct'
          LIMIT 1
        ) peer ON TRUE
        LEFT JOIN LATERAL (
          -- Whole: encrypted text cannot be shortened.
          SELECT id, sender_id, kind, content, created_at,
                 (SELECT username FROM users WHERE users.id = messages.sender_id) AS sender_username
          FROM messages
          WHERE messages.chat_id = chats.id
            AND (
              chat_members.cleared_at IS NULL
              OR messages.created_at > chat_members.cleared_at
            )
            AND (chats.type = 'direct' OR messages.created_at >= chat_members.joined_at)
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        ) last_message ON TRUE
        -- Not shown if it was cleared ("clear history for me").
        LEFT JOIN messages pinned
          ON pinned.id = chats.pinned_message_id
         AND (chat_members.cleared_at IS NULL OR pinned.created_at > chat_members.cleared_at)
        WHERE NOT chat_members.hidden
        ORDER BY chat_members.pinned_at DESC NULLS LAST,
                 chats.updated_at DESC,
                 chats.id
        `,
        [request.user.id],
      );

      return {
        chats: result.rows.map(
          ({
            pinned_message_id,
            pinned_message_sender_id,
            pinned_message_content,
            pinned_message_created_at,
            last_message_id,
            last_message_sender_id,
            last_message_sender_username,
            last_message_kind,
            last_message_content,
            last_message_created_at,
            presence_visible,
            ...chat
          }) => ({
            ...chat,
            ...presenceView({
              user_id: chat.user_id,
              last_seen_at: chat.last_seen_at,
              presence_visible,
            }),
            pinned_message: pinned_message_id
              ? {
                  id: pinned_message_id,
                  sender_id: pinned_message_sender_id,
                  content: pinned_message_content,
                  created_at: pinned_message_created_at,
                }
              : null,
            last_message: last_message_id
              ? {
                  id: last_message_id,
                  sender_id: last_message_sender_id,
                  sender_username: last_message_sender_username,
                  kind: last_message_kind,
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
      config: chatsRateLimit,
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

  // PIN A MESSAGE at the top of the chat, for both members; null unpins.
  server.put<{ Params: { chatId: string }; Body: { message_id: string | null } }>(
    "/api/chats/:chatId/pinned-message",
    {
      preHandler: authenticate,
      config: chatsRateLimit,
      schema: {
        params: chatParamsSchema,
        body: {
          type: "object",
          required: ["message_id"],
          properties: {
            message_id: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
          },
        },
      },
    },
    async (request, reply) => {
      const { chatId } = request.params;
      const messageId = request.body.message_id;

      if (!(await isChatMember(chatId, request.user.id))) {
        return reply.status(404).send({ error: "Chat not found" });
      }

      if (await isBlockedInChat(chatId, request.user.id)) {
        return reply.status(403).send({ error: "You can't change this chat" });
      }

      // In a group, only admins pin.
      const group = await groupMembership(chatId, request.user.id);

      if (group && !isAdmin(group.role)) {
        return reply.status(403).send({ error: "Only the group's admins can pin messages" });
      }

      const result = await db.query(
        `
        UPDATE chats
        SET pinned_message_id = $2
        WHERE id = $1
          AND ($2::uuid IS NULL OR EXISTS (
            SELECT 1 FROM messages WHERE id = $2 AND chat_id = $1
          ))
        RETURNING (
          SELECT json_build_object(
            'id', m.id, 'sender_id', m.sender_id,
            'content', m.content, 'created_at', m.created_at
          )
          FROM messages m WHERE m.id = $2
        ) AS message
        `,
        [chatId, messageId],
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: "Message not found in this chat" });
      }

      const message = result.rows[0].message ?? null;
      await sendToChatMembers(chatId, { type: "pinned_message", chatId, message });

      return { message };
    },
  );

  // DELETE CHAT. ?for=everyone (the default): for both members, with all
  // its messages. ?for=me: clears the history for this user only and
  // hides the chat until the next message.
  server.delete<{
    Params: { chatId: string };
    Querystring: { for: "everyone" | "me" };
  }>(
    "/api/chats/:chatId",
    {
      preHandler: authenticate,
      config: chatsRateLimit,
      schema: {
        params: chatParamsSchema,
        querystring: {
          type: "object",
          properties: {
            for: { type: "string", enum: ["everyone", "me"], default: "everyone" },
          },
        },
      },
    },
    async (request, reply) => {
      const { chatId } = request.params;

      if (request.query.for === "me") {
        const result = await db.query(
          `
          UPDATE chat_members
          SET cleared_at = NOW(),
              last_read_at = GREATEST(last_read_at, NOW()),
              pinned_at = NULL,
              hidden = TRUE
          WHERE chat_id = $1
            AND user_id = $2
          `,
          [chatId, request.user.id],
        );

        if (result.rowCount === 0) {
          return reply.status(404).send({
            error: "Chat not found",
          });
        }

        // The user's other devices close and forget it as well.
        sendToUserSockets(request.user.id, { type: "chat_deleted", chatId });

        return { deleted: true };
      }

      if (!(await isChatMember(chatId, request.user.id))) {
        return reply.status(404).send({
          error: "Chat not found",
        });
      }

      // A group is deleted for everyone only by its owner (the others
      // leave it).
      const group = await groupMembership(chatId, request.user.id);

      if (group && group.role !== "owner") {
        return reply.status(403).send({ error: "Only the group's owner can delete it" });
      }

      // Tell the members while they are still members.
      await sendToChatMembers(chatId, { type: "chat_deleted", chatId });
      await db.query("DELETE FROM chats WHERE id = $1", [chatId]);

      return { deleted: true };
    },
  );
}
