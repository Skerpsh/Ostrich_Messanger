import { db } from "./database.js";

export const MAX_MESSAGE_LENGTH = 4096;

export type ChatMessage = {
  id: string;
  chat_id: string;
  sender_id: string;
  sender_username: string;
  content: string;
  created_at: Date;
};

// Saves a message and bumps the chat's updated_at in one statement.
// Returns null if the sender is not a member of the chat.
export async function createMessage(
  chatId: string,
  senderId: string,
  content: string,
): Promise<ChatMessage | null> {
  const result = await db.query(
    `
    WITH inserted AS (
      INSERT INTO messages (
        chat_id,
        sender_id,
        content
      )
      SELECT $1, $2, $3
      WHERE EXISTS (
        SELECT 1
        FROM chat_members
        WHERE chat_id = $1
          AND user_id = $2
      )
      RETURNING id, chat_id, sender_id, content, created_at
    ),
    touched AS (
      UPDATE chats
      SET updated_at = NOW()
      WHERE id = (SELECT chat_id FROM inserted)
    )
    SELECT
      inserted.id,
      inserted.chat_id,
      inserted.sender_id,
      users.username AS sender_username,
      inserted.content,
      inserted.created_at
    FROM inserted
    JOIN users ON users.id = inserted.sender_id
    `,
    [chatId, senderId, content],
  );

  return result.rows[0] ?? null;
}
