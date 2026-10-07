import { db } from "./database.js";

export const MAX_MESSAGE_LENGTH = 4096;

// Length of the quoted text of the message a reply refers to.
const REPLY_PREVIEW_LENGTH = 200;

export type ReplyPreview = {
  id: string;
  sender_id: string;
  sender_username: string;
  sender_is_developer: boolean;
  content: string;
};

export type ChatMessage = {
  id: string;
  chat_id: string;
  sender_id: string;
  sender_username: string;
  content: string;
  created_at: Date;
  reply_to: ReplyPreview | null;
};

// Columns of the replied-to message, joined as "reply" and "reply_sender".
export const REPLY_COLUMNS = `
  reply.id AS reply_id,
  reply.sender_id AS reply_sender_id,
  reply_sender.username AS reply_sender_username,
  reply_sender.is_developer AS reply_sender_is_developer,
  LEFT(reply.content, ${REPLY_PREVIEW_LENGTH}) AS reply_content
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
  | { error: "not_member" | "reply_not_found" };

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
    return { message: withReply(result.rows[0]) as ChatMessage };
  }

  // Nothing inserted: tell why.
  const member = await db.query(
    `
    SELECT 1
    FROM chat_members
    WHERE chat_id = $1
      AND user_id = $2
    `,
    [chatId, senderId],
  );

  return { error: member.rows.length > 0 ? "reply_not_found" : "not_member" };
}

export const CREATE_MESSAGE_ERRORS = {
  not_member: "You are not a member of this chat",
  reply_not_found: "The message you reply to is not in this chat",
} as const;
