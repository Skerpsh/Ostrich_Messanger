import { db } from "./database.js";

export const MAX_MESSAGE_LENGTH = 4096;

export type ChatMessage = {
  id: string;
  chat_id: string;
  sender_id: string;
  sender_username: string;
  content: string;
  created_at: Date;
  // The replied-to message (null fields if this is not a reply).
  reply_to_id: string | null;
  reply_sender_username: string | null;
  reply_content: string | null;
};

// Columns of a ChatMessage, for a query over `messages` (aliased as `m`)
// joined with JOIN_REPLY.
export const MESSAGE_COLUMNS = `
  m.id,
  m.chat_id,
  m.sender_id,
  sender.username AS sender_username,
  m.content,
  m.created_at,
  m.reply_to_id,
  reply_sender.username AS reply_sender_username,
  reply.content AS reply_content
`;

export const JOIN_REPLY = `
  JOIN users sender ON sender.id = m.sender_id
  LEFT JOIN messages reply ON reply.id = m.reply_to_id
  LEFT JOIN users reply_sender ON reply_sender.id = reply.sender_id
`;

// Saves a message and bumps the chat's updated_at in one statement.
// Returns null if the sender is not a member of the chat. A reply to a
// message that is not in the same chat is saved as a plain message.
export async function createMessage(
  chatId: string,
  senderId: string,
  content: string,
  replyToId: string | null = null,
): Promise<ChatMessage | null> {
  const result = await db.query(
    `
    WITH inserted AS (
      INSERT INTO messages (
        chat_id,
        sender_id,
        content,
        reply_to_id
      )
      SELECT
        $1,
        $2,
        $3,
        (SELECT id FROM messages WHERE id = $4 AND chat_id = $1)
      WHERE EXISTS (
        SELECT 1
        FROM chat_members
        WHERE chat_id = $1
          AND user_id = $2
      )
      RETURNING id, chat_id, sender_id, content, created_at, reply_to_id
    ),
    touched AS (
      UPDATE chats
      SET updated_at = NOW()
      WHERE id = (SELECT chat_id FROM inserted)
    )
    SELECT ${MESSAGE_COLUMNS}
    FROM inserted m
    ${JOIN_REPLY}
    `,
    [chatId, senderId, content, replyToId],
  );

  return result.rows[0] ?? null;
}
