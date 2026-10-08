import { useEffect, useState, useSyncExternalStore } from "react";
import { useAuth } from "@/context/auth";
import * as api from "./api";
import type { Chat, GroupMember, GroupRotation, Message, WrappedGroupKey } from "./api";
import { loadAttachment } from "./attachments";
import { cacheGet, cacheSet } from "./cache";
import {
  decryptGroupInfo,
  decryptGroupMessage,
  encryptGroupInfo,
  encryptGroupMessage,
  newGroupKey,
  newMessageId,
  publicKeyOf,
  unwrapGroupKey,
  wrapGroupKey,
  type GroupInfo,
} from "./crypto";
import { imageSource } from "./files";
import { checkPeerKey } from "./known-keys";

// Groups on this device: their keys (one per epoch, wrapped for this user
// by whoever made it, see crypto.ts), their decrypted name and photo, the
// messages the server writes about them, and the changes members make.

export const MAX_GROUP_MEMBERS = 50;

// --- keys ---

// Unwrapped keys by chat and epoch; forgotten on logout.
const keys = new Map<string, Map<number, Uint8Array>>();
// Groups with a key wrapped by someone whose account key has changed
// since this device first saw it: not used, see loadGroupKeys().
const distrusted = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function changed() {
  version++;

  for (const listener of listeners) {
    listener();
  }
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function groupKeyOf(chatId: string, epoch: number) {
  return keys.get(chatId)?.get(epoch);
}

export function clearGroupKeys() {
  keys.clear();
  distrusted.clear();
  loading.clear();
  changed();
}

function addGroupKey(chatId: string, epoch: number, key: Uint8Array) {
  let epochs = keys.get(chatId);

  if (!epochs) {
    epochs = new Map();
    keys.set(chatId, epochs);
  }

  epochs.set(epoch, key);
  changed();
}

const wrappedCacheKey = (userId: string, chatId: string) => `${userId}:group-keys:${chatId}`;

// Unwraps the keys wrapped for this user. A key counts only if whoever
// wrapped it still has the account key this device knows them by (as for
// direct chats, known-keys.ts): otherwise the server could hand out a key
// of its own and read what is written with it.
async function unwrapAll(
  chatId: string,
  wrapped: WrappedGroupKey[],
  ownId: string,
  privateKey: Uint8Array,
) {
  const ownPublicKey = publicKeyOf(privateKey);

  for (const item of wrapped) {
    if (groupKeyOf(chatId, item.epoch)) {
      continue;
    }

    if (item.wrapper_public_key !== ownPublicKey && item.wrapper_id) {
      if ((await checkPeerKey(ownId, item.wrapper_id, item.wrapper_public_key)) === "changed") {
        distrusted.add(chatId);
        continue;
      }
    }

    try {
      addGroupKey(
        chatId,
        item.epoch,
        unwrapGroupKey(item.wrapped_key, item.epoch, chatId, privateKey, ownId, item.wrapper_public_key),
      );
    } catch {
      // Not for this user: skipped.
    }
  }
}

const loading = new Map<string, Promise<void>>();

// Loads the group's keys: those saved on the device first (they are
// wrapped), then the server's if the current one is missing.
function loadGroupKeys(
  chatId: string,
  epoch: number,
  ownId: string,
  privateKey: Uint8Array,
  withToken: <T>(call: (token: string) => Promise<T>) => Promise<T>,
) {
  const running = loading.get(chatId);

  if (running) {
    return running;
  }

  const load = (async () => {
    const cached = await cacheGet<WrappedGroupKey[]>(wrappedCacheKey(ownId, chatId));

    if (cached) {
      await unwrapAll(chatId, cached, ownId, privateKey);
    }

    if (groupKeyOf(chatId, epoch)) {
      return;
    }

    const fetched = await withToken((token) => api.getGroupKeys(token, chatId));
    await cacheSet(wrappedCacheKey(ownId, chatId), fetched);
    await unwrapAll(chatId, fetched, ownId, privateKey);
  })().finally(() => loading.delete(chatId));

  loading.set(chatId, load);

  return load;
}

// Keeps a group's keys loaded; the returned version changes whenever a key
// arrives (what was unreadable may be readable now).
export function useGroupKeys(chat: Chat | null | undefined) {
  const { state, withToken } = useAuth();
  const signedIn = state.status === "signedIn" ? state : null;
  const current = useSyncExternalStore(subscribe, () => version);

  const chatId = chat?.type === "group" ? chat.id : null;
  const epoch = chat?.key_epoch ?? 0;
  const missing = chatId !== null && !groupKeyOf(chatId, epoch);
  const privateKey = signedIn?.privateKey ?? null;
  const ownId = signedIn?.user.id ?? null;

  useEffect(() => {
    if (missing && chatId && privateKey && ownId) {
      loadGroupKeys(chatId, epoch, ownId, privateKey, withToken).catch(() => {});
    }
  }, [chatId, epoch, missing, privateKey, ownId, withToken]);

  return current;
}

// Loads the keys of the given groups (the chats list shows their names).
export function useAllGroupKeys(chats: Chat[] | null) {
  const { state, withToken } = useAuth();
  const signedIn = state.status === "signedIn" ? state : null;
  const current = useSyncExternalStore(subscribe, () => version);
  const privateKey = signedIn?.privateKey ?? null;
  const ownId = signedIn?.user.id ?? null;

  useEffect(() => {
    if (!chats || !privateKey || !ownId) {
      return;
    }

    for (const chat of chats) {
      if (chat.type === "group" && !groupKeyOf(chat.id, chat.key_epoch)) {
        loadGroupKeys(chat.id, chat.key_epoch, ownId, privateKey, withToken).catch(() => {});
      }
    }
  }, [chats, privateKey, ownId, withToken]);

  return current;
}

// A key of this group came from an account whose key has changed.
export const isGroupDistrusted = (chatId: string) => distrusted.has(chatId);

// --- name and photo ---

export function groupInfo(chat: Chat): GroupInfo | null {
  return chat.type === "group" && chat.encrypted_info
    ? decryptGroupInfo(chat.encrypted_info, (epoch) => groupKeyOf(chat.id, epoch), chat.id)
    : null;
}

// What a chat is called: "@user", or the group's name.
export function chatTitle(chat: Chat) {
  if (chat.type === "group") {
    return groupInfo(chat)?.name ?? "Group";
  }

  return `@${chat.username ?? "…"}`;
}

// The name for avatars' first letter.
export function chatName(chat: Chat) {
  return chat.type === "group" ? (groupInfo(chat)?.name ?? "Group") : (chat.username ?? "?");
}

// The group's decrypted photo, as a URI for <Image>.
export function useGroupPhoto(photo: GroupInfo["photo"] | undefined) {
  const { withToken } = useAuth();
  const [shown, setShown] = useState<{ id: string; uri: string } | null>(null);
  // Decrypted again on every render: the effect goes by the photo itself.
  const id = photo?.id;
  const key = photo?.key;
  const mime = photo?.mime;

  useEffect(() => {
    if (!id || !key || !mime) {
      return;
    }

    let current = true;
    let uri: string | null = null;

    withToken((token) => loadAttachment(token, { id, key, mime, name: "photo", size: 0 })).then(
      (bytes) => {
        if (current) {
          uri = imageSource(bytes, mime);
          setShown({ id, uri });
        }
      },
      () => {},
    );

    return () => {
      current = false;

      if (uri?.startsWith("blob:")) {
        URL.revokeObjectURL(uri);
      }
    };
  }, [id, key, mime, withToken]);

  return id && shown?.id === id ? shown.uri : null;
}

// --- system messages ---

type SystemUser = { id: string; username: string };

type SystemEvent =
  | { type: "created" }
  | { type: "added"; users: SystemUser[] }
  | { type: "removed"; users: SystemUser[] }
  | { type: "left" }
  | { type: "role"; user: SystemUser; role: "admin" | "member" }
  | { type: "info" }
  | { type: "owner"; user: SystemUser };

// What a message the server wrote about a group says, e.g. "@ann added
// @bob".
export function systemText(message: Pick<Message, "sender_id" | "sender_username" | "content">, ownId: string | null) {
  const name = (user: SystemUser) => (user.id === ownId ? "you" : `@${user.username}`);
  const actor = message.sender_id === ownId ? "You" : `@${message.sender_username}`;

  let event: SystemEvent;

  try {
    event = JSON.parse(message.content);
  } catch {
    return "Group changed";
  }

  switch (event.type) {
    case "created":
      return `${actor} created the group`;
    case "added":
      return `${actor} added ${event.users.map(name).join(", ")}`;
    case "removed":
      return `${actor} removed ${event.users.map(name).join(", ")}`;
    case "left":
      return `${actor} left the group`;
    case "role":
      return event.role === "admin"
        ? `${actor} made ${name(event.user)} an admin`
        : `${actor} made ${name(event.user)} a member`;
    case "info":
      return `${actor} changed the group's name or photo`;
    case "owner": {
      const owner = name(event.user);
      return `${owner.charAt(0).toUpperCase()}${owner.slice(1)} ${event.user.id === ownId ? "are" : "is"} now the owner`;
    }
    default:
      return "Group changed";
  }
}

// --- changes ---

type WithToken = <T>(call: (token: string) => Promise<T>) => Promise<T>;

type Me = { id: string; privateKey: Uint8Array };

// Members whose key cannot be wrapped for: not set up yet.
function withKeys<T extends { public_key: string | null }>(users: T[]) {
  const missing = users.filter((u) => !u.public_key);

  if (missing.length > 0) {
    throw new api.ApiError(
      "Some of these users have not set up end-to-end encryption yet: they need to open the updated Ostrich once.",
      400,
    );
  }

  return users as (T & { public_key: string })[];
}

// Creates a group with these members (found by @username); returns its id.
export async function createGroup(
  withToken: WithToken,
  me: Me,
  name: string,
  members: api.FoundUser[],
) {
  const id = newMessageId();
  const key = newGroupKey();
  const everyone = [{ id: me.id, public_key: publicKeyOf(me.privateKey) }, ...withKeys(members)];

  await withToken((token) =>
    api.createGroup(token, {
      id,
      encrypted_info: encryptGroupInfo({ name }, key, 1, id),
      keys: everyone.map((member) => ({
        user_id: member.id,
        wrapped_key: wrapGroupKey(key, 1, id, me.privateKey, member.id, member.public_key),
      })),
    }),
  );

  addGroupKey(id, 1, key);

  return id;
}

// A new key for the group, wrapped for `members`, with the info encrypted
// with it.
function rotation(chat: Chat, me: Me, members: GroupMember[], info: GroupInfo): {
  rotation: GroupRotation;
  key: Uint8Array;
} {
  const epoch = chat.key_epoch + 1;
  const key = newGroupKey();

  return {
    key,
    rotation: {
      epoch,
      encrypted_info: encryptGroupInfo(info, key, epoch, chat.id),
      keys: withKeys(members).map((member) => ({
        user_id: member.id,
        wrapped_key: wrapGroupKey(key, epoch, chat.id, me.privateKey, member.id, member.public_key),
      })),
    },
  };
}

function currentInfo(chat: Chat) {
  const info = groupInfo(chat);

  if (!info) {
    throw new api.ApiError("The group's key has not loaded yet", 409);
  }

  return info;
}

// Makes the group's next key (someone left, or an admin wants a new one).
export async function rotateGroupKey(withToken: WithToken, me: Me, chat: Chat) {
  const info = currentInfo(chat);
  const members = await withToken((token) => api.getGroupMembers(token, chat.id));
  const next = rotation(chat, me, members, info);

  await withToken((token) => api.rotateGroupKey(token, chat.id, next.rotation));
  addGroupKey(chat.id, next.rotation.epoch, next.key);
}

export async function addGroupMember(withToken: WithToken, me: Me, chat: Chat, user: api.FoundUser) {
  const key = groupKeyOf(chat.id, chat.key_epoch);
  const [member] = withKeys([user]);

  if (!key) {
    throw new api.ApiError("The group's key has not loaded yet", 409);
  }

  await withToken((token) =>
    api.addGroupMember(token, chat.id, {
      user_id: member.id,
      epoch: chat.key_epoch,
      wrapped_key: wrapGroupKey(key, chat.key_epoch, chat.id, me.privateKey, member.id, member.public_key),
    }),
  );
}

// Removes a member; the others get the next key right away, so the
// removed member cannot read what follows.
export async function removeGroupMember(withToken: WithToken, me: Me, chat: Chat, userId: string) {
  const info = currentInfo(chat);
  const members = await withToken((token) => api.getGroupMembers(token, chat.id));
  const next = rotation(
    chat,
    me,
    members.filter((m) => m.id !== userId),
    info,
  );

  await withToken((token) => api.removeGroupMember(token, chat.id, userId, next.rotation));
  addGroupKey(chat.id, next.rotation.epoch, next.key);
}

export function leaveGroup(withToken: WithToken, me: Me, chat: Chat) {
  return withToken((token) => api.removeGroupMember(token, chat.id, me.id));
}

// Renames the group or changes its photo (photo: a new one, null to
// remove, undefined to keep).
export async function saveGroupInfo(
  withToken: WithToken,
  chat: Chat,
  name: string,
  photo?: GroupInfo["photo"] | null,
) {
  const key = groupKeyOf(chat.id, chat.key_epoch);
  const info = currentInfo(chat);

  if (!key) {
    throw new api.ApiError("The group's key has not loaded yet", 409);
  }

  const next: GroupInfo = { name, ...(photo === undefined ? info.photo && { photo: info.photo } : photo && { photo }) };

  await withToken((token) =>
    api.setGroupInfo(token, chat.id, {
      encrypted_info: encryptGroupInfo(next, key, chat.key_epoch, chat.id),
      ...(photo === undefined ? {} : { photo_id: photo?.id ?? null }),
    }),
  );
}

// A message the server refused because the group's key changed (or has
// to change: someone left) since it was encrypted: makes the new key if
// needed and encrypts the message again with it. Returns the new content.
export async function reencryptForGroup(
  withToken: WithToken,
  me: Me,
  message: { id: string; chatId: string; content: string },
) {
  const ref = { id: message.id, sender_id: me.id };
  const old = decryptGroupMessage(
    { ...ref, content: message.content },
    (epoch) => groupKeyOf(message.chatId, epoch),
    message.chatId,
  );

  if (old.status !== "ok") {
    throw new api.ApiError("This message can no longer be sent", 400);
  }

  const chats = await withToken(api.getChats);
  let chat = chats.find((c) => c.id === message.chatId);

  if (!chat || chat.type !== "group") {
    throw new api.ApiError("You are no longer in this group", 403);
  }

  const fetched = await withToken((token) => api.getGroupKeys(token, chat!.id));
  await cacheSet(wrappedCacheKey(me.id, chat.id), fetched);
  await unwrapAll(chat.id, fetched, me.id, me.privateKey);

  if (chat.rotation_needed) {
    await rotateGroupKey(withToken, me, chat);
    chat = { ...chat, key_epoch: chat.key_epoch + 1, rotation_needed: false };
  }

  const key = groupKeyOf(chat.id, chat.key_epoch);

  if (!key) {
    throw new api.ApiError("The group's key cannot be read", 409);
  }

  return encryptGroupMessage(old.text, ref, key, chat.key_epoch, chat.id);
}
