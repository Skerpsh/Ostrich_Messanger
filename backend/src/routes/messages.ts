import { FastifyInstance } from "fastify";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "../attachments.js";
import { db } from "../database.js";
import { authenticate } from "../middleware/auth.js";
import { groupMembership, isAdmin } from "../groups.js";
import {
  CREATE_MESSAGE_ERRORS,
  CREATE_MESSAGE_STATUS,
  createMessage,
  getMessage,
  groupEpochOf,
  isBlockedInChat,
  MAX_MESSAGE_LENGTH,
  MESSAGE_PATTERN,
  MESSAGE_SELECT,
  needsClientId,
  REACTIONS,
  withReply,
} from "../messages.js";
import { notifyNewMessage } from "../push.js";
import {
  announcePresence,
  sendToChatMembers,
  sendToUserSockets,
} from "../realtime.js";

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

type MessageParams = ChatParams & { messageId: string };

const messageParamsSchema = {
  type: "object",
  required: ["chatId", "messageId"],
  properties: {
    chatId: { type: "string", format: "uuid" },
    messageId: { type: "string", format: "uuid" },
  },
} as const;

export default async function messagesRoutes(server: FastifyInstance) {
  // SEND MESSAGE
  server.post<{
    Params: ChatParams;
    Body: { id?: string; content: string; reply_to?: string; attachments?: string[] };
  }>(
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
            // Chosen by the client: "e2" messages are bound to their id.
            id: { type: "string", format: "uuid" },
            content: {
              type: "string",
              maxLength: MAX_MESSAGE_LENGTH,
              pattern: MESSAGE_PATTERN,
            },
            // Id of the message (in this chat) this one replies to.
            reply_to: { type: "string", format: "uuid" },
            // Encrypted files uploaded for this message (attachments.ts).
            attachments: {
              type: "array",
              maxItems: MAX_ATTACHMENTS_PER_MESSAGE,
              uniqueItems: true,
              items: { type: "string", format: "uuid" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { chatId } = request.params;
      const { content, id } = request.body;

      if (!id && needsClientId(content)) {
        return reply.status(400).send({
          error: "id is required for this message format",
        });
      }

      const result = await createMessage(
        chatId,
        request.user.id,
        content,
        request.body.reply_to ?? null,
        id ?? null,
        request.body.attachments ?? [],
      );

      if ("error" in result) {
        return reply
          .status(CREATE_MESSAGE_STATUS[result.error])
          .send({ error: CREATE_MESSAGE_ERRORS[result.error], code: result.error });
      }

      const { message } = result;
      notifyNewMessage(chatId, request.user.id);

      // Deliver to clients connected over websocket.
      await sendToChatMembers(chatId, {
        type: "message",
        message,
      });

      if (result.firstFromSender) {
        await announcePresence(request.user.id, chatId);
      }

      return reply.status(201).send({
        message,
      });
    },
  );

  // GET MESSAGES: the newest `limit` messages, or the `limit` messages
  // before the message `before` (loading older history); oldest first.
  server.get<{
    Params: ChatParams;
    Querystring: { limit: number; before?: string };
  }>(
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
              maximum: 500,
              default: 100,
            },
            before: { type: "string", format: "uuid" },
          },
        },
      },
    },
    async (request, reply) => {
      const { chatId } = request.params;
      const { limit, before } = request.query;

      // In a group, members see the messages since they joined.
      const member = await db.query(
        `
        SELECT chat_members.cleared_at,
               CASE WHEN chats.type = 'group' THEN chat_members.joined_at END AS joined_at
        FROM chat_members
        JOIN chats ON chats.id = chat_members.chat_id
        WHERE chat_members.chat_id = $1 AND chat_members.user_id = $2
        `,
        [chatId, request.user.id],
      );

      if (member.rows.length === 0) {
        return reply.status(403).send({
          error: "You are not a member of this chat",
        });
      }

      // One more than asked, to tell whether there is older history.
      // Messages up to cleared_at were cleared by the user ("clear history").
      const result = await db.query(
        `
        SELECT *
        FROM (
          ${MESSAGE_SELECT}
          WHERE m.chat_id = $1
            AND ($4::timestamptz IS NULL OR m.created_at > $4)
            AND ($5::timestamptz IS NULL OR m.created_at >= $5)
            AND (
              $3::uuid IS NULL
              OR (m.created_at, m.id) < (
                SELECT created_at, id FROM messages WHERE id = $3 AND chat_id = $1
              )
            )
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT $2 + 1
        ) latest
        ORDER BY created_at ASC, id ASC
        `,
        [chatId, limit, before ?? null, member.rows[0].cleared_at, member.rows[0].joined_at],
      );

      const hasMore = result.rows.length > limit;
      const rows = hasMore ? result.rows.slice(1) : result.rows;

      // Read positions: the user's own (where unread messages start) and
      // the others' (which of the user's messages have been read: in a
      // group, by anyone who has read receipts on), only if the user has
      // read receipts on.
      const reads = await db.query(
        `
        SELECT
          MAX(cm.last_read_at) FILTER (WHERE cm.user_id = $2) AS last_read_at,
          MAX(cm.last_read_at) FILTER (WHERE cm.user_id <> $2 AND u.read_receipts) AS peer_last_read_at,
          BOOL_OR(u.read_receipts) FILTER (WHERE cm.user_id = $2) AS receipts
        FROM chat_members cm
        JOIN users u ON u.id = cm.user_id
        WHERE cm.chat_id = $1
        `,
        [chatId, request.user.id],
      );

      const { last_read_at, peer_last_read_at, receipts } = reads.rows[0];

      return reply.send({
        messages: rows.map(withReply),
        has_more: hasMore,
        last_read_at,
        peer_last_read_at: receipts ? peer_last_read_at : null,
      });
    },
  );

  // EDIT MESSAGE: own messages only; the new text is encrypted too.
  server.patch<{ Params: MessageParams; Body: { content: string } }>(
    "/api/chats/:chatId/messages/:messageId",
    {
      preHandler: authenticate,
      config: sendRateLimit,
      schema: {
        params: messageParamsSchema,
        body: {
          type: "object",
          required: ["content"],
          properties: {
            content: {
              type: "string",
              maxLength: MAX_MESSAGE_LENGTH,
              pattern: MESSAGE_PATTERN,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { chatId, messageId } = request.params;

      if (await isBlockedInChat(chatId, request.user.id)) {
        return reply.status(403).send({ error: CREATE_MESSAGE_ERRORS.blocked });
      }

      // In a group the new text is encrypted with the current key.
      const group = await groupMembership(chatId, request.user.id);
      const epoch = groupEpochOf(request.body.content);

      if (group ? epoch !== group.key_epoch || group.rotation_needed : epoch !== null) {
        return reply.status(409).send({
          error: CREATE_MESSAGE_ERRORS.group_key_changed,
          code: "group_key_changed",
        });
      }

      const result = await db.query(
        `
        UPDATE messages
        SET content = $4, edited_at = NOW()
        WHERE id = $1
          AND chat_id = $2
          AND sender_id = $3
          AND kind = 'text'
        RETURNING id
        `,
        [messageId, chatId, request.user.id, request.body.content],
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({
          error: "You can only edit your own messages",
        });
      }

      const message = await getMessage(messageId);
      await sendToChatMembers(chatId, { type: "message_updated", message });

      return { message };
    },
  );

  // DELETE MESSAGE: own messages, for everyone.
  server.delete<{ Params: MessageParams }>(
    "/api/chats/:chatId/messages/:messageId",
    {
      preHandler: authenticate,
      config: sendRateLimit,
      schema: { params: messageParamsSchema },
    },
    async (request, reply) => {
      const { chatId, messageId } = request.params;

      // In a group, admins delete any message.
      const group = await groupMembership(chatId, request.user.id);

      const result = await db.query(
        `
        DELETE FROM messages
        WHERE id = $1
          AND chat_id = $2
          AND (sender_id = $3 OR $4::boolean)
        RETURNING id
        `,
        [messageId, chatId, request.user.id, Boolean(group && isAdmin(group.role))],
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({
          error: "You can only delete your own messages",
        });
      }

      await sendToChatMembers(chatId, {
        type: "message_deleted",
        chatId,
        messageId,
      });

      return { deleted: true };
    },
  );

  // REACT: sets (or replaces) the user's reaction; emoji null removes it.
  server.put<{ Params: MessageParams; Body: { emoji: string | null } }>(
    "/api/chats/:chatId/messages/:messageId/reaction",
    {
      preHandler: authenticate,
      config: readRateLimit,
      schema: {
        params: messageParamsSchema,
        body: {
          type: "object",
          required: ["emoji"],
          properties: {
            emoji: { type: ["string", "null"], enum: [...REACTIONS, null] },
          },
        },
      },
    },
    async (request, reply) => {
      const { chatId, messageId } = request.params;
      const { emoji } = request.body;

      const target = await db.query(
        `
        SELECT 1
        FROM messages
        JOIN chat_members ON chat_members.chat_id = messages.chat_id
        WHERE messages.id = $1
          AND messages.chat_id = $2
          AND chat_members.user_id = $3
        `,
        [messageId, chatId, request.user.id],
      );

      if (target.rows.length === 0) {
        return reply.status(404).send({
          error: "Message not found in this chat",
        });
      }

      if (emoji !== null && (await isBlockedInChat(chatId, request.user.id))) {
        return reply.status(403).send({ error: CREATE_MESSAGE_ERRORS.blocked });
      }

      if (emoji === null) {
        await db.query(
          "DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2",
          [messageId, request.user.id],
        );
      } else {
        await db.query(
          `
          INSERT INTO message_reactions (message_id, user_id, emoji)
          VALUES ($1, $2, $3)
          ON CONFLICT (message_id, user_id)
          DO UPDATE SET emoji = EXCLUDED.emoji, created_at = NOW()
          `,
          [messageId, request.user.id, emoji],
        );
      }

      const message = await getMessage(messageId);
      await sendToChatMembers(chatId, {
        type: "reactions",
        chatId,
        messageId,
        reactions: message?.reactions ?? [],
      });

      return { reactions: message?.reactions ?? [] };
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
      const event = { type: "read", chatId, userId: request.user.id, lastReadAt };

      // Other devices of the user clear their unread count; the other
      // member sees their messages as read, unless either has turned read
      // receipts off.
      // Shared if the reader has read receipts on (in a direct chat, the
      // other member too); members with them off do not show them.
      const receipts = await db.query(
        `
        SELECT CASE WHEN chats.type = 'group'
          THEN (SELECT read_receipts FROM users WHERE id = $2)
          ELSE BOOL_AND(users.read_receipts)
        END AS on
        FROM chats
        JOIN chat_members ON chat_members.chat_id = chats.id
        JOIN users ON users.id = chat_members.user_id
        WHERE chats.id = $1
        GROUP BY chats.type
        `,
        [chatId, request.user.id],
      );

      if (receipts.rows[0]?.on) {
        await sendToChatMembers(chatId, event);
      } else {
        sendToUserSockets(request.user.id, event);
      }

      return reply.send({
        last_read_at: lastReadAt,
      });
    },
  );
}
