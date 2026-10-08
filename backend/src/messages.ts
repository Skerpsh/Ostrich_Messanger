import { db, isPgError, PG_UNIQUE_VIOLATION } from "./database.js";
import { blockedEitherWay } from "./visibility.js";

// Messages are end-to-end encrypted, see frontend/src/lib/crypto.ts:
//   "e2:" + base64(nonce + ciphertext), bound to the chat, the sender and
//         the message id, which the client chooses for that reason;
//   "e1:" the same bound to the chat only (older clients).
// The server cannot read or shorten them; clients limit the text to 4096
// characters before encrypting, which is at most ~22 000 characters of
// base64.
export const MESSAGE_PATTERN = "^e[12]:[A-Za-z0-9+/]+={0,2}$";
export const MAX_MESSAGE_LENGTH = 22_000;

const MESSAGE_RE = new RegExp(MESSAGE_PATTERN);

export function isEncryptedMessage(content: string) {
  return content.length <= MAX_MESSAGE_LENGTH && MESSAGE_RE.test(content);
}

// "e2" messages are bound to their id, so the client must choose it.
export function needsClientId(content: string) {
  return content.startsWith("e2:");
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

// Columns of the replied-to message, joined as "reply" and "reply_sender".
const REPLY_COLUMNS = `
  reply.id AS reply_id,
  reply.sender_id AS reply_sender_id,
  reply_sender.username AS reply_sender_username,
  reply_sender.is_developer AS reply_sender_is_developer,
  -- Whole: encrypted text cannot be shortened; clients shorten the quote.
  reply.content AS reply_content
`;

const REPLY_JOINS = (message: string) => `
  LEFT JOIN messages reply ON reply.id = ${message}.reply_to_id
  LEFT JOIN users reply_sender ON reply_sender.id = reply.sender_id
`;

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
    ${REPLY_COLUMNS},
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
  ${REPLY_JOINS("m")}
`;

export async function getMessage(messageId: string): Promise<ChatMessage | null> {
  const result = await db.query(`${MESSAGE_SELECT} WHERE m.id = $1`, [messageId]);

  return result.rows[0] ? (withReply(result.rows[0]) as ChatMessage) : null;
}

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

export type CreateMessageError =
  | "not_member"
  | "reply_not_found"
  | "blocked"
  | "duplicate_id"
  | "attachment_invalid";

export type CreateMessageResult =
  | {
      message: ChatMessage;
      // The sender's first message in the chat: from now on the other
      // member may see their presence (see presenceVisible()).
      firstFromSender: boolean;
    }
  | { error: CreateMessageError };

// SQL: whether the attachments in parameter `ids` are uploads of the
// sender ($2) not yet sent in a message.
const attachmentsFree = (ids: string) => `(
  SELECT COUNT(*) FROM attachments
  WHERE id = ANY(${ids}::uuid[])
    AND uploader_id = $2
    AND message_id IS NULL
) = cardinality(${ids}::uuid[])`;

// SQL: whether $2 (a member of chat $1) and the chat's other member have
// blocked each other, in either direction.
const BLOCKED_IN_CHAT = `EXISTS (
  SELECT 1
  FROM chat_members other
  WHERE other.chat_id = $1
    AND other.user_id <> $2
    AND ${blockedEitherWay("$2::uuid", "other.user_id")}
)`;

// Saves a message, bumps the chat's updated_at and the sender's read
// position, unhides the chat for its members and links its attachments,
// in one statement. A reply must refer to a message of the same chat.
// `messageId` is the id chosen by the client (required for "e2").
export async function createMessage(
  chatId: string,
  senderId: string,
  content: string,
  replyToId: string | null = null,
  messageId: string | null = null,
  attachmentIds: string[] = [],
): Promise<CreateMessageResult> {
  let result;

  try {
    result = await db.query(
      `
      WITH inserted AS (
        INSERT INTO messages (
          id,
          chat_id,
          sender_id,
          content,
          reply_to_id
        )
        SELECT COALESCE($5::uuid, gen_random_uuid()), $1, $2, $3, $4
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
        AND NOT ${BLOCKED_IN_CHAT}
        AND ${attachmentsFree("$6")}
        RETURNING id, chat_id, sender_id, content, created_at, reply_to_id
      ),
      linked AS (
        UPDATE attachments
        SET message_id = (SELECT id FROM inserted)
        WHERE id = ANY($6::uuid[])
          AND uploader_id = $2
          AND message_id IS NULL
          AND EXISTS (SELECT 1 FROM inserted)
      ),
      touched AS (
        UPDATE chats
        SET updated_at = NOW()
        WHERE id = (SELECT chat_id FROM inserted)
      ),
      -- Whoever writes has read the chat up to their own message. A new
      -- message shows the chat to members who had it hidden.
      members AS (
        UPDATE chat_members
        SET last_read_at = CASE
              WHEN user_id = $2
                THEN GREATEST(last_read_at, (SELECT created_at FROM inserted))
              ELSE last_read_at
            END,
            hidden = FALSE
        WHERE chat_id = (SELECT chat_id FROM inserted)
      )
      SELECT
        inserted.id,
        inserted.chat_id,
        inserted.sender_id,
        users.username AS sender_username,
        inserted.content,
        inserted.created_at,
        ${REPLY_COLUMNS},
        -- The statement's snapshot does not contain the new row yet.
        NOT EXISTS (
          SELECT 1 FROM messages
          WHERE chat_id = $1
            AND sender_id = $2
        ) AS first_from_sender
      FROM inserted
      JOIN users ON users.id = inserted.sender_id
      ${REPLY_JOINS("inserted")}
      `,
      [chatId, senderId, content, replyToId, messageId, attachmentIds],
    );
  } catch (error) {
    if (isPgError(error, PG_UNIQUE_VIOLATION)) {
      return { error: "duplicate_id" };
    }

    throw error;
  }

  if (result.rows[0]) {
    const { first_from_sender, ...row } = result.rows[0];

    return {
      message: {
        ...(withReply(row) as Omit<ChatMessage, "edited_at" | "reactions">),
        edited_at: null,
        reactions: [],
      },
      firstFromSender: first_from_sender,
    };
  }

  // Nothing inserted: tell why.
  const why = await db.query(
    `
    SELECT
      EXISTS (
        SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2
      ) AS member,
      ${BLOCKED_IN_CHAT} AS blocked,
      ${attachmentsFree("$3")} AS attachments_free
    `,
    [chatId, senderId, attachmentIds],
  );

  const { member, blocked, attachments_free } = why.rows[0];

  return {
    error: !member
      ? "not_member"
      : blocked
        ? "blocked"
        : !attachments_free
          ? "attachment_invalid"
          : "reply_not_found",
  };
}

// Whether the user and the other member of the chat blocked each other.
export async function isBlockedInChat(chatId: string, userId: string) {
  const result = await db.query(`SELECT ${BLOCKED_IN_CHAT} AS blocked`, [
    chatId,
    userId,
  ]);

  return result.rows[0].blocked as boolean;
}

export const CREATE_MESSAGE_ERRORS: Record<CreateMessageError, string> = {
  not_member: "You are not a member of this chat",
  reply_not_found: "The message you reply to is not in this chat",
  blocked: "You can't message this user",
  duplicate_id: "A message with this id already exists",
  attachment_invalid: "An attachment is missing or was already sent",
};

export const CREATE_MESSAGE_STATUS: Record<CreateMessageError, number> = {
  not_member: 403,
  reply_not_found: 400,
  blocked: 403,
  duplicate_id: 409,
  attachment_invalid: 400,
};
