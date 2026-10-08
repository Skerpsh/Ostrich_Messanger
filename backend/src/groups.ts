import type { PoolClient } from "pg";
import { db } from "./database.js";
import type { ChatMessage } from "./messages.js";
import { sendToChatMembers } from "./realtime.js";

// Groups: limits, roles and the messages the server writes about them.

export const MAX_GROUP_MEMBERS = 50;

export type Role = "owner" | "admin" | "member";

// What happened in a group, as its system message says.
export type GroupEvent =
  | { type: "created" }
  | { type: "added"; users: { id: string; username: string }[] }
  | { type: "removed"; users: { id: string; username: string }[] }
  | { type: "left" }
  | { type: "role"; user: { id: string; username: string }; role: Role }
  | { type: "info" }
  | { type: "owner"; user: { id: string; username: string } };

// Writes a system message (inside the caller's transaction); send it with
// announceMessages() once committed.
export async function addSystemMessage(
  client: PoolClient,
  chatId: string,
  actorId: string,
  event: GroupEvent,
): Promise<ChatMessage> {
  const result = await client.query(
    `
    WITH inserted AS (
      INSERT INTO messages (chat_id, sender_id, content, kind)
      VALUES ($1, $2, $3, 'system')
      RETURNING id, chat_id, sender_id, content, kind, created_at
    ),
    touched AS (
      UPDATE chats SET updated_at = NOW() WHERE id = $1
    )
    SELECT inserted.*, users.username AS sender_username
    FROM inserted
    JOIN users ON users.id = inserted.sender_id
    `,
    [chatId, actorId, JSON.stringify(event)],
  );

  return { ...result.rows[0], edited_at: null, reply_to: null, reactions: [], mentions: [] };
}

export async function announceMessages(messages: ChatMessage[]) {
  for (const message of messages) {
    await sendToChatMembers(message.chat_id, { type: "message", message });
  }
}

// The user's membership of a group (with the group's key state), or null.
export async function groupMembership(chatId: string, userId: string, client: PoolClient | typeof db = db) {
  const result = await client.query(
    `
    SELECT chat_members.role, chats.key_epoch, chats.rotation_needed
    FROM chat_members
    JOIN chats ON chats.id = chat_members.chat_id AND chats.type = 'group'
    WHERE chat_members.chat_id = $1
      AND chat_members.user_id = $2
    `,
    [chatId, userId],
  );

  return (result.rows[0] ?? null) as {
    role: Role;
    key_epoch: number;
    rotation_needed: boolean;
  } | null;
}

export const isAdmin = (role: Role | undefined) => role === "owner" || role === "admin";

// Makes the longest-serving admin (else member) the owner, after the
// owner left; returns them.
export async function handOverOwnership(client: PoolClient, chatId: string) {
  const heir = await client.query(
    `
    UPDATE chat_members SET role = 'owner'
    WHERE chat_id = $1 AND user_id = (
      SELECT user_id FROM chat_members
      WHERE chat_id = $1
      ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, joined_at
      LIMIT 1
    )
    RETURNING user_id
    `,
    [chatId],
  );

  if (heir.rows.length === 0) {
    return null;
  }

  const user = await client.query("SELECT id, username FROM users WHERE id = $1", [heir.rows[0].user_id]);

  return user.rows[0] as { id: string; username: string };
}

// Takes a user out of all their groups (their account is being deleted):
// ownership is handed over, the groups need a new key, empty ones go.
// Returns the groups that remain.
export async function leaveAllGroups(client: PoolClient, userId: string) {
  const groups = await client.query(
    `
    DELETE FROM chat_members
    USING chats
    WHERE chats.id = chat_members.chat_id
      AND chats.type = 'group'
      AND chat_members.user_id = $1
    RETURNING chat_members.chat_id, chat_members.role
    `,
    [userId],
  );

  const remaining: string[] = [];

  for (const { chat_id: chatId, role } of groups.rows) {
    const empty = await client.query(
      "DELETE FROM chats WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM chat_members WHERE chat_id = $1) RETURNING id",
      [chatId],
    );

    if (empty.rows.length > 0) {
      continue;
    }

    if (role === "owner") {
      await handOverOwnership(client, chatId);
    }

    await client.query("UPDATE chats SET rotation_needed = TRUE WHERE id = $1", [chatId]);
    remaining.push(chatId);
  }

  return remaining;
}
