import type { Chat, Message } from "./api";
import { loadCachedMessages } from "./local-cache";
import { plainText } from "./markup";
import { messagePreview } from "./preview";
import { showMessage } from "./use-chat-crypto";

// Searching all chats: the server cannot (the messages are encrypted), so
// the messages saved on this device (local-cache.ts, the newest few
// hundred of each chat opened here) are decrypted and searched.

export type MessageMatch = {
  chat: Chat;
  message: Message;
  // The message's text without formatting.
  text: string;
};

const MAX_RESULTS = 50;

export async function searchMessages(
  userId: string,
  chats: Chat[],
  privateKey: Uint8Array | null,
  query: string,
): Promise<MessageMatch[]> {
  const needle = query.trim().toLowerCase();

  if (needle.length < 2) {
    return [];
  }

  const found: MessageMatch[] = [];

  for (const chat of chats) {
    const messages = (await loadCachedMessages(userId, chat.id)) ?? [];

    for (const message of messages) {
      if (message.kind === "system") {
        continue;
      }

      const shown = showMessage(message, privateKey, chat, userId);

      if (shown.status !== "ok") {
        continue;
      }

      const text = plainText(shown.text);

      if (text.toLowerCase().includes(needle) || messagePreview(shown).toLowerCase().includes(needle)) {
        found.push({ chat, message, text: text.trim() || messagePreview(shown) });
      }
    }
  }

  return found
    .sort((a, b) => new Date(b.message.created_at).getTime() - new Date(a.message.created_at).getTime())
    .slice(0, MAX_RESULTS);
}

// A piece of the text around the match, for the results list.
export function snippet(text: string, query: string, around = 40) {
  const line = text.replace(/\s+/g, " ");
  const at = line.toLowerCase().indexOf(query.trim().toLowerCase());

  if (at <= around) {
    return line;
  }

  return `…${line.slice(at - around)}`;
}
