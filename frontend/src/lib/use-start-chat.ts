import { useCallback } from "react";
import { useAuth } from "@/context/auth";
import { useChats } from "@/context/chats";
import { useRealtime } from "@/context/realtime";
import { createChat } from "./api";

// Opens (or finds) the direct chat with a user and adds it to the chats
// list; throws the server's error, e.g. "User not found".
export function useStartChat() {
  const { withToken } = useAuth();
  const { seedPresence } = useRealtime();
  const { addChat } = useChats();

  return useCallback(
    async (username: string) => {
      const chat = await withToken((token) => createChat(token, username));

      seedPresence([
        {
          userId: chat.user_id,
          presence: { online: chat.online, lastSeenAt: chat.last_seen_at },
        },
      ]);
      addChat(chat);

      return chat;
    },
    [withToken, seedPresence, addChat],
  );
}
