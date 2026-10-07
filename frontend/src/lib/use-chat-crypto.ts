import { useMemo } from "react";
import { useCurrentUser, usePrivateKey } from "@/context/auth";
import type { Chat } from "./api";
import { decodePayload, type Payload } from "./payload";
import {
  decryptMessage,
  encryptMessage,
  publicKeyOf,
  safetyCode,
  type Decrypted,
  type MessageRef,
} from "./crypto";

// A message as shown: its decryption status and what it carries.
export type Shown = Decrypted & Omit<Payload, "text">;

// Decrypts a message and reads its payload (text, forward); text that was
// not encrypted is shown as it is.
export function showMessage(
  message: MessageRef & { content: string },
  privateKey: Uint8Array | null,
  peerKey: string | null,
  chatId: string,
): Shown {
  const decrypted = decryptMessage(message, privateKey, peerKey, chatId);

  return decrypted.status === "ok"
    ? { ...decrypted, ...decodePayload(decrypted.text) }
    : decrypted;
}

// Encrypting and decrypting a chat's messages with this device's keys.
export function useChatCrypto(chat: Chat | null) {
  const privateKey = usePrivateKey();
  const ownId = useCurrentUser()?.id ?? null;
  const chatId = chat?.id ?? "";
  const peerKey = chat?.public_key ?? null;
  const username = chat?.username;

  return useMemo(
    () => ({
      // Can messages be sent? Not until the other member has keys.
      canEncrypt: Boolean(privateKey && peerKey && ownId),

      decrypt: (message: MessageRef & { content: string }): Shown =>
        showMessage(message, privateKey, peerKey, chatId),

      // `text`: the encoded payload (encodePayload). `messageId`: a new id
      // (newMessageId()) or, for an edit, the message's own.
      encrypt: (text: string, messageId: string) => {
        if (!privateKey || !peerKey || !ownId) {
          throw new Error(
            `@${username ?? "…"} has not set up end-to-end encryption yet: they need to open the updated Ostrich once.`,
          );
        }

        return encryptMessage(
          text,
          { id: messageId, sender_id: ownId },
          privateKey,
          peerKey,
          chatId,
        );
      },

      // Compared with the other member's to rule out swapped keys; null
      // until both have keys.
      safetyCode:
        privateKey && peerKey ? safetyCode(publicKeyOf(privateKey), peerKey) : null,
    }),
    [privateKey, peerKey, chatId, ownId, username],
  );
}
