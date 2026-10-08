import { useMemo } from "react";
import { useCurrentUser, usePrivateKey } from "@/context/auth";
import type { Chat, Message } from "./api";
import { decodePayload, type Payload } from "./payload";
import {
  decryptGroupMessage,
  decryptMessage,
  encryptGroupMessage,
  encryptMessage,
  isGroupMessage,
  publicKeyOf,
  safetyCode,
  type Decrypted,
  type MessageRef,
} from "./crypto";
import { groupKeyOf, systemText, useGroupKeys } from "./groups";

// A message as shown: its decryption status and what it carries. "system":
// written by the server about a group ("@ann added @bob"), not encrypted.
export type Shown = (Decrypted | { status: "system"; text: string }) & Omit<Payload, "text">;

type ChatKeys = Pick<Chat, "id" | "type" | "public_key">;

type MessageText = Pick<Message, "content"> & Partial<Pick<Message, "kind" | "sender_username">>;

// Decrypts a message and reads its payload (text, forward); text that was
// not encrypted is shown as it is. Group messages need the group's keys
// (lib/groups.ts), direct ones the other member's public key.
export function showMessage(
  message: MessageRef & MessageText,
  privateKey: Uint8Array | null,
  chat: ChatKeys,
  ownId: string | null = null,
): Shown {
  if (message.kind === "system") {
    return {
      status: "system",
      text: systemText({ ...message, sender_username: message.sender_username ?? "…" }, ownId),
    };
  }

  const decrypted =
    chat.type === "group"
      ? isGroupMessage(message.content)
        ? decryptGroupMessage(message, (epoch) => groupKeyOf(chat.id, epoch), chat.id)
        : decryptMessage(message, null, null, chat.id)
      : decryptMessage(message, privateKey, chat.public_key, chat.id);

  return decrypted.status === "ok"
    ? { ...decrypted, ...decodePayload(decrypted.text) }
    : decrypted;
}

// Encrypts a message for any chat (forwarding): with the group's key, or
// for the other member. Throws if the keys are not there.
export function encryptForChat(
  chat: Chat,
  text: string,
  message: MessageRef,
  privateKey: Uint8Array,
) {
  if (chat.type === "group") {
    const key = groupKeyOf(chat.id, chat.key_epoch);

    if (!key) {
      throw new Error("The group's key has not loaded yet");
    }

    return encryptGroupMessage(text, message, key, chat.key_epoch, chat.id);
  }

  if (!chat.public_key) {
    throw new Error(`@${chat.username ?? "…"} has not set up end-to-end encryption yet`);
  }

  return encryptMessage(text, message, privateKey, chat.public_key, chat.id);
}

// Encrypting and decrypting a chat's messages with this device's keys.
export function useChatCrypto(chat: Chat | null) {
  const privateKey = usePrivateKey();
  const ownId = useCurrentUser()?.id ?? null;
  const chatId = chat?.id ?? "";
  const type = chat?.type ?? "direct";
  const peerKey = chat?.public_key ?? null;
  const epoch = chat?.key_epoch ?? 0;
  const username = chat?.username;
  // A new key makes unreadable messages readable: decrypt again.
  const keysVersion = useGroupKeys(chat);

  return useMemo(() => {
    const groupKey = type === "group" ? groupKeyOf(chatId, epoch) : undefined;
    const keys: ChatKeys = { id: chatId, type, public_key: peerKey };

    return {
      keysVersion,

      // Can messages be sent? Not until the other member has keys (or the
      // group's key has loaded).
      canEncrypt: Boolean(privateKey && ownId && (type === "group" ? groupKey : peerKey)),

      decrypt: (message: MessageRef & MessageText): Shown =>
        showMessage(message, privateKey, keys, ownId),

      // `text`: the encoded payload (encodePayload). `messageId`: a new id
      // (newMessageId()) or, for an edit, the message's own.
      encrypt: (text: string, messageId: string) => {
        const ref = { id: messageId, sender_id: ownId ?? "" };

        if (type === "group") {
          if (!groupKey || !ownId) {
            throw new Error("The group's key has not loaded yet: try again in a moment.");
          }

          return encryptGroupMessage(text, ref, groupKey, epoch, chatId);
        }

        if (!privateKey || !peerKey || !ownId) {
          throw new Error(
            `@${username ?? "…"} has not set up end-to-end encryption yet: they need to open the updated Ostrich once.`,
          );
        }

        return encryptMessage(text, ref, privateKey, peerKey, chatId);
      },

      // Compared with the other member's to rule out swapped keys; null
      // until both have keys (and in groups: per member, on the group's
      // screen).
      safetyCode:
        type === "direct" && privateKey && peerKey
          ? safetyCode(publicKeyOf(privateKey), peerKey)
          : null,
    };
  }, [privateKey, peerKey, chatId, type, epoch, ownId, username, keysVersion]);
}
