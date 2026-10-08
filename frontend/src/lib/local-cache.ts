import type { Outgoing } from "@/context/outbox";
import type { Chat, Message } from "./api";
import { cacheClear, cacheGet, cacheSet } from "./cache";

// What the device keeps of an account (cache.ts): the chats list, the
// newest messages of each chat and the outbox. Keys start with the user's
// id, so logging out removes everything of the account at once.

// How many of a chat's newest messages are kept on the device.
export const CACHED_MESSAGES = 300;

const key = (userId: string, ...parts: string[]) => [userId, ...parts].join(":");

export const loadCachedChats = (userId: string) => cacheGet<Chat[]>(key(userId, "chats"));

export const saveCachedChats = (userId: string, chats: Chat[]) =>
  cacheSet(key(userId, "chats"), chats);

export const loadCachedMessages = (userId: string, chatId: string) =>
  cacheGet<Message[]>(key(userId, "messages", chatId));

export const saveCachedMessages = (userId: string, chatId: string, messages: Message[]) =>
  cacheSet(key(userId, "messages", chatId), messages.slice(-CACHED_MESSAGES));

// A deleted or cleared chat.
export const forgetCachedChat = (userId: string, chatId: string) =>
  cacheClear(key(userId, "messages", chatId));

export const loadCachedOutbox = (userId: string) => cacheGet<Outgoing[]>(key(userId, "outbox"));

export const saveCachedOutbox = (userId: string, outgoing: Outgoing[]) =>
  cacheSet(key(userId, "outbox"), outgoing);

// Everything of the account, when it logs out.
export const forgetAccountCache = (userId: string) => cacheClear(`${userId}:`);
