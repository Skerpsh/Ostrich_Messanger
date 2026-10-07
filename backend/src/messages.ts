import { db } from "./database.js";

// Messages are end-to-end encrypted: "e1:" + base64(nonce + ciphertext),
// see frontend/src/lib/crypto.ts. The server cannot read or shorten them;
// clients limit the text to 4096 characters before encrypting, which is at
// most ~22 000 characters of base64.
export const MESSAGE_PATTERN = "^e1:[A-Za-z0-9+/]+={0,2}$";
export const MAX_MESSAGE_LENGTH = 22_000;

export function isEncryptedMessage(content: string) {
  return (
    content.length <= MAX_MESSAGE_LENGTH &&
    new RegExp(MESSAGE_PATTERN).test(content)
  );
}

export type ReplyPreview = {
  id: string;
  sender_id: string;
  sender_username: string;
  sender_is_developer: boolean;
  content: string;
};

export type Reaction = { emoji: string; user_id: string };

export type ChatMessage = {
  id: string;
  chat_id: string;
  sender_id: string;
  sender_username: string;
  content: string;
  created_at: Date;
  edited_at: Date | null;
  reply_to: ReplyPreview | null;
  reactions: Reaction[];
};

// The emoji a message can be reacted with.
export const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🔥", "🙏", "👎"] as const;

// A whole message as clients get it: text, quote, edit time, reactions.
// Use as "${MESSAGE_SELECT} WHERE m.…".
export const MESSAGE_SELECT = `
  SELECT
    m.id,
    m.chat_id,
    m.sender_id,
    sender.username AS sender_username,
    m.content,
    m.created_at,
    m.edited_at,
    reply.id AS reply_id,
    reply.sender_id AS reply_sender_id,
    reply_sender.username AS reply_sender_username,
    reply_sender.is_developer AS reply_sender_is_developer,
    reply.content AS reply_content,
    COALESCE(
      (
        SELECT json_agg(
          json_build_object('emoji', r.emoji, 'user_id', r.user_id)
          ORDER BY r.created_at
        )
        FROM message_reactions r
        WHERE r.message_id = m.id
      ),
      '[]'
    ) AS reactions
  FROM messages m
  JOIN users sender ON sender.id = m.sender_id
  LEFT JOIN messages reply ON reply.id = m.reply_to_id
  LEFT JOIN users reply_sender ON reply_sender.id = reply.sender_id
`;

export async function getMessage(messageId: string): Promise<ChatMessage | null> {
  const result = await db.query(`${MESSAGE_SELECT} WHERE m.id = $1`, [messageId]);

  return result.rows[0] ? (withReply(result.rows[0]) as ChatMessage) : null;
}

// Columns of the replied-to message, joined as "reply" and "reply_sender".
export const REPLY_COLUMNS = `
  reply.id AS reply_id,
  reply.sender_id AS reply_sender_id,
  reply_sender.username AS reply_sender_username,
  reply_sender.is_developer AS reply_sender_is_developer,
  -- Whole: encrypted text cannot be shortened; clients shorten the quote.
  reply.content AS reply_content
`;

// Turns the flat reply_* columns of a row into the reply_to object.
export function withReply<
  T extends {
    reply_id: string | null;
    reply_sender_id: string | null;
    reply_sender_username: string | null;
    reply_sender_is_developer: boolean | null;
    reply_content: string | null;
  },
>({
  reply_id,
  reply_sender_id,
  reply_sender_username,
  reply_sender_is_developer,
  reply_content,
  ...row
}: T) {
  return {
    ...row,
    reply_to: reply_id
      ? {
          id: reply_id,
          sender_id: reply_sender_id!,
          sender_username: reply_sender_username!,
          sender_is_developer: reply_sender_is_developer ?? false,
          content: reply_content!,
        }
      : null,
  };
}

export type CreateMessageResult =
  | { message: ChatMessage }
  | { error: "not_member" | "reply_not_found" | "blocked" };

// SQL: whether $2 (the sender) and the other member of chat $1 have
// blocked each other, in either direction.
const SENDER_BLOCKED = `EXISTS (
  SELECT 1
  FROM chat_members other
  JOIN blocks b
    ON (b.blocker_id = other.user_id AND b.blocked_id = $2)
    OR (b.blocker_id = $2 AND b.blocked_id = other.user_id)
  WHERE other.chat_id = $1
    AND other.user_id <> $2
)`;

// Saves a message, bumps the chat's updated_at and the sender's read
// position in one statement. A reply must refer to a message of the same
// chat.
export async function createMessage(
  chatId: string,
  senderId: string,
  content: string,
  replyToId: string | null = null,
): Promise<CreateMessageResult> {
  const result = await db.query(
    `
    WITH inserted AS (
      INSERT INTO messages (
        chat_id,
        sender_id,
        content,
        reply_to_id
      )
      SELECT $1, $2, $3, $4
      WHERE EXISTS (
        SELECT 1
        FROM chat_members
        WHERE chat_id = $1
          AND user_id = $2
      )
      AND (
        $4::uuid IS NULL
        OR EXISTS (
          SELECT 1
          FROM messages
          WHERE id = $4
            AND chat_id = $1
        )
      )
      AND NOT ${SENDER_BLOCKED}
      RETURNING id, chat_id, sender_id, content, created_at, reply_to_id
    ),
    touched AS (
      UPDATE chats
      SET updated_at = NOW()
      WHERE id = (SELECT chat_id FROM inserted)
    ),
    -- Whoever writes has read the chat up to their own message.
    sender_read AS (
      UPDATE chat_members
      SET last_read_at = GREATEST(last_read_at, (SELECT created_at FROM inserted))
      WHERE chat_id = (SELECT chat_id FROM inserted)
        AND user_id = $2
    )
    SELECT
      inserted.id,
      inserted.chat_id,
      inserted.sender_id,
      users.username AS sender_username,
      inserted.content,
      inserted.created_at,
      ${REPLY_COLUMNS}
    FROM inserted
    JOIN users ON users.id = inserted.sender_id
    LEFT JOIN messages reply ON reply.id = inserted.reply_to_id
    LEFT JOIN users reply_sender ON reply_sender.id = reply.sender_id
    `,
    [chatId, senderId, content, replyToId],
  );

  if (result.rows[0]) {
    return {
      message: {
        ...(withReply(result.rows[0]) as Omit<ChatMessage, "edited_at" | "reactions">),
        edited_at: null,
        reactions: [],
      },
    };
  }

  // Nothing inserted: tell why.
  const why = await db.query(
    `
    SELECT
      EXISTS (
        SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2
      ) AS member,
      ${SENDER_BLOCKED} AS blocked
    `,
    [chatId, senderId],
  );

  const { member, blocked } = why.rows[0];

  return {
    error: !member ? "not_member" : blocked ? "blocked" : "reply_not_found",
  };
}

// Whether the user and the other member of the chat blocked each other.
export async function isBlockedInChat(chatId: string, userId: string) {
  const result = await db.query(`SELECT ${SENDER_BLOCKED} AS blocked`, [
    chatId,
    userId,
  ]);

  return result.rows[0].blocked as boolean;
}

export const CREATE_MESSAGE_ERRORS = {
  not_member: "You are not a member of this chat",
  reply_not_found: "The message you reply to is not in this chat",
  blocked: "You can't message this user",
} as const;
