import { useMemo } from "react";
import { usePrivateKey } from "@/context/auth";
import type { Chat } from "./api";
import { decryptMessage, encryptMessage, type Decrypted } from "./crypto";

// Encrypting and decrypting a chat's messages with this device's keys.
export function useChatCrypto(chat: Chat | null) {
  const privateKey = usePrivateKey();
  const chatId = chat?.id ?? "";
  const peerKey = chat?.public_key ?? null;

  return useMemo(
    () => ({
      // Can messages be sent? Not until the other member has keys.
      canEncrypt: Boolean(privateKey && peerKey),

      decrypt: (content: string): Decrypted =>
        decryptMessage(content, privateKey, peerKey, chatId),

      encrypt: (text: string) => {
        if (!privateKey || !peerKey) {
          throw new Error(
            `@${chat?.username ?? "…"} has not set up end-to-end encryption yet: they need to open the updated Ostrich once.`,
          );
        }

        return encryptMessage(text, privateKey, peerKey, chatId);
      },
    }),
    [privateKey, peerKey, chatId, chat?.username],
  );
}
