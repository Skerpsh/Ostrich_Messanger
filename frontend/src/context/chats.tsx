import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppState, Platform } from "react-native";
import { router } from "expo-router";
import { useAuth } from "@/context/auth";
import { useRealtime } from "@/context/realtime";
import * as api from "@/lib/api";
import type { Chat, Message } from "@/lib/api";
import {
  forgetAccountCache,
  forgetCachedChat,
  loadCachedChats,
  saveCachedChats,
} from "@/lib/local-cache";
import { messagePreview } from "@/lib/preview";
import { getItem, removeItem, setItem } from "@/lib/storage";
import { showMessage } from "@/lib/use-chat-crypto";
import {
  showMessageNotification,
  syncPushToken,
  useNotificationTaps,
} from "@/lib/notifications";
import { useLatest } from "@/lib/use-latest";

// How long "typing…" shows after the last typing event.
const TYPING_MS = 6000;

type ChatsContextValue = {
  // null until the first load (from the device or the server).
  chats: Chat[] | null;
  // The list has come from the server since the app started.
  synced: boolean;
  error: string | null;
  reload: () => Promise<void>;
  totalUnread: number;
  // A chat created on this device (shown before the next reload).
  addChat: (chat: Chat) => void;
  // The chat on screen: its incoming messages are marked read right away
  // while the app is visible.
  setActiveChat: (chatId: string | null) => void;
  // The chat on screen has shown everything up to this message.
  markChatRead: (chatId: string, message: Message) => void;
  // The other user's read position, from a history load.
  setPeerReadAt: (chatId: string, lastReadAt: string | null) => void;
  // Chats where the other member is typing.
  typing: Set<string>;
  // Pin / mute (for this user). Shown right away; undone if it fails.
  updateChatSettings: (
    chatId: string,
    settings: { pinned?: boolean; muted?: boolean },
  ) => Promise<void>;
  // Deletes the chat for both members ("everyone") or clears it for this
  // user ("me").
  removeChat: (chatId: string, scope: "everyone" | "me") => Promise<void>;
  // Unsent text per chat, kept on this device.
  drafts: Record<string, string>;
  setDraft: (chatId: string, text: string) => void;
  // Pins a message for both members (null unpins).
  pinMessage: (chatId: string, messageId: string | null) => Promise<void>;
};

// The chats list is saved to the device this long after its last change.
const CACHE_SAVE_DELAY_MS = 1000;

// Drafts are kept per account: an index of the chats that have one, and
// one entry per chat (secure storage on the phones limits value sizes).
const draftIndexKey = (userId: string) => `ostrich-drafts-${userId}`;
const draftKey = (userId: string, chatId: string) => `ostrich-draft-${userId}-${chatId}`;
const DRAFT_SAVE_DELAY_MS = 500;

const ChatsContext = createContext<ChatsContextValue | null>(null);

const later = (a: string | null, b: string | null) =>
  !a ? b : !b ? a : new Date(a) >= new Date(b) ? a : b;

const isAfter = (a: string, b: string | null) =>
  !b || new Date(a).getTime() > new Date(b).getTime();

function openChat(chatId: string) {
  router.navigate({ pathname: "/chats/[chatId]", params: { chatId } });
}

// Moves a chat with a new message to the top: of the pinned chats if it is
// pinned, otherwise right below them.
function moveToTop(chats: Chat[], chat: Chat) {
  const rest = chats.filter((c) => c.id !== chat.id);
  const index = chat.pinned ? 0 : rest.findIndex((c) => !c.pinned);
  const at = index < 0 ? rest.length : index;

  return [...rest.slice(0, at), chat, ...rest.slice(at)];
}

// Whether the user can see the app (tab visible / app in the foreground).
function useAppVisible() {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (Platform.OS === "web") {
      const update = () =>
        setVisible(document.visibilityState === "visible");
      update();
      document.addEventListener("visibilitychange", update);
      return () => document.removeEventListener("visibilitychange", update);
    }

    const subscription = AppState.addEventListener("change", (state) =>
      setVisible(state === "active"),
    );
    return () => subscription.remove();
  }, []);

  return visible;
}

// The chats list with last messages and unread counts, kept up to date
// from websocket events; shared by the list, the chat screen and the
// sidebar on wide screens.
export function ChatsProvider({ children }: { children: ReactNode }) {
  const { state, withToken, updateUser } = useAuth();
  const privateKey = state.status === "signedIn" ? state.privateKey : null;
  const privateKeyRef = useLatest(privateKey);
  const [typingUntil, setTypingUntil] = useState<Record<string, number>>({});
  const { status, seedPresence, subscribeEvents } = useRealtime();
  const userId = state.status === "signedIn" ? state.user.id : null;

  const [chats, setChats] = useState<Chat[] | null>(null);
  const [synced, setSynced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const visible = useAppVisible();

  const [drafts, setDrafts] = useState<Record<string, string>>({});

  // Another account: forget the previous one's chats and drafts.
  const [chatsOwner, setChatsOwner] = useState(userId);

  if (chatsOwner !== userId) {
    setChatsOwner(userId);
    setChats(null);
    setSynced(false);
    setDrafts({});
  }

  const chatsRef = useLatest(chats);
  const viewingRef = useLatest(visible ? activeChatId : null);

  const reload = useCallback(async () => {
    try {
      const loaded = await withToken(api.getChats);

      seedPresence(
        loaded.map((chat) => ({
          userId: chat.user_id,
          presence: { online: chat.online, lastSeenAt: chat.last_seen_at },
        })),
      );
      setChats(loaded);
      setSynced(true);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load chats");
    }
  }, [withToken, seedPresence]);

  // The chats saved on the device show until the server answers (and
  // when offline). Presence is not taken from them: it is out of date.
  useEffect(() => {
    if (!userId) {
      return;
    }

    let current = true;

    loadCachedChats(userId).then((cached) => {
      if (current && cached && chatsRef.current === null) {
        setChats(cached);
      }
    });

    return () => {
      current = false;
    };
  }, [userId, chatsRef]);

  useEffect(() => {
    if (!userId || chats === null) {
      return;
    }

    const timer = setTimeout(() => saveCachedChats(userId, chats), CACHE_SAVE_DELAY_MS);

    return () => clearTimeout(timer);
  }, [userId, chats]);

  // Drafts: loaded with the account; removed from the device when it logs
  // out (they are plain text).
  const draftTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    if (!userId) {
      return;
    }

    let current = true;
    const timers = draftTimers.current;

    (async () => {
      const index: string[] = JSON.parse((await getItem(draftIndexKey(userId))) ?? "[]");
      const loaded: Record<string, string> = {};

      for (const chatId of index) {
        const text = await getItem(draftKey(userId, chatId));

        if (text) {
          loaded[chatId] = text;
        }
      }

      if (current) {
        setDrafts(loaded);
      }
    })().catch(() => {});

    return () => {
      current = false;

      for (const timer of timers.values()) {
        clearTimeout(timer);
      }

      timers.clear();
    };
  }, [userId]);

  const previousUser = useRef(userId);

  useEffect(() => {
    const previous = previousUser.current;
    previousUser.current = userId;

    if (previous && !userId) {
      forgetAccountCache(previous);

      (async () => {
        const index: string[] = JSON.parse((await getItem(draftIndexKey(previous))) ?? "[]");
        await Promise.all(index.map((chatId) => removeItem(draftKey(previous, chatId))));
        await removeItem(draftIndexKey(previous));
      })().catch(() => {});
    }
  }, [userId]);

  const draftsRef = useLatest(drafts);

  const setDraft = useCallback(
    (chatId: string, text: string) => {
      if (!userId || (draftsRef.current[chatId] ?? "") === text) {
        return;
      }

      setDrafts((current) => {
        const next = { ...current };

        if (text.trim()) {
          next[chatId] = text;
        } else {
          delete next[chatId];
        }

        return next;
      });

      const timers = draftTimers.current;
      clearTimeout(timers.get(chatId));
      timers.set(
        chatId,
        setTimeout(() => {
          timers.delete(chatId);
          const all = draftsRef.current;
          const index = Object.keys(all);

          (all[chatId]
            ? setItem(draftKey(userId, chatId), all[chatId])
            : removeItem(draftKey(userId, chatId))
          )
            .then(() => setItem(draftIndexKey(userId), JSON.stringify(index)))
            .catch(() => {});
        }, DRAFT_SAVE_DELAY_MS),
      );
    },
    [userId, draftsRef],
  );

  // Reloading after every (re)connect also picks up what was missed.
  useEffect(() => {
    if (userId && (status === "online" || chatsRef.current === null)) {
      reload();
    }
  }, [userId, status, reload, chatsRef]);

  const sendRead = useCallback(
    (chatId: string, messageId: string) => {
      withToken((token) => api.markRead(token, chatId, messageId)).catch(
        () => {},
      );
    },
    [withToken],
  );

  const markChatRead = useCallback(
    (chatId: string, message: Message) => {
      const chat = chatsRef.current?.find((c) => c.id === chatId);

      if (chat && chat.unread_count === 0 && message.sender_id === userId) {
        return;
      }

      setChats((current) =>
        current?.map((c) => (c.id === chatId ? { ...c, unread_count: 0 } : c)) ??
        current,
      );
      sendRead(chatId, message.id);
    },
    [sendRead, userId, chatsRef],
  );

  // Coming back to the app with the active chat open marks it read.
  useEffect(() => {
    if (!visible || !activeChatId) {
      return;
    }

    const chat = chatsRef.current?.find((c) => c.id === activeChatId);

    if (chat?.last_message && chat.unread_count > 0) {
      setChats((current) =>
        current?.map((c) =>
          c.id === activeChatId ? { ...c, unread_count: 0 } : c,
        ) ?? current,
      );
      sendRead(activeChatId, chat.last_message.id);
    }
  }, [visible, activeChatId, sendRead, chatsRef]);

  useEffect(
    () =>
      subscribeEvents({
        onMessage: (message) => {
          const known = chatsRef.current?.some((c) => c.id === message.chat_id);

          if (!known) {
            // A chat someone else has just started.
            reload();
            return;
          }

          const incoming = message.sender_id !== userId;
          const viewing = viewingRef.current === message.chat_id;

          setChats((current) => {
            if (!current) {
              return current;
            }

            const chat = current.find((c) => c.id === message.chat_id);

            if (!chat || chat.last_message?.id === message.id) {
              return current;
            }

            const updated: Chat = {
              ...chat,
              updated_at: message.created_at,
              last_message: {
                id: message.id,
                sender_id: message.sender_id,
                // Whole: encrypted text cannot be shortened.
                content: message.content,
                created_at: message.created_at,
              },
              unread_count:
                incoming && !viewing ? chat.unread_count + 1 : chat.unread_count,
            };

            // Most recently active first (after the pinned chats).
            return moveToTop(current, updated);
          });

          if (incoming && viewing) {
            sendRead(message.chat_id, message.id);
          }

          if (incoming) {
            // The message ends "typing…".
            setTypingUntil(({ [message.chat_id]: _, ...rest }) => rest);

            const chat = chatsRef.current?.find((c) => c.id === message.chat_id);

            // Web: a browser notification unless the chat is on screen or muted.
            if (chat && !chat.muted && !viewing) {
              showMessageNotification(
                `@${chat.username}`,
                messagePreview(
                  showMessage(message, privateKeyRef.current, chat.public_key, chat.id),
                ),
                chat.id,
                openChat,
              );
            }
          }
        },
        onRead: ({ chatId, userId: readerId, lastReadAt }) => {
          let recount = false;

          setChats((current) =>
            current?.map((chat) => {
              if (chat.id !== chatId) {
                return chat;
              }

              if (readerId !== userId) {
                return {
                  ...chat,
                  peer_last_read_at: later(chat.peer_last_read_at, lastReadAt),
                };
              }

              // Read on another device of this user.
              if (
                !chat.last_message ||
                !isAfter(chat.last_message.created_at, lastReadAt)
              ) {
                return { ...chat, unread_count: 0 };
              }

              recount = true;
              return chat;
            }) ?? current,
          );

          if (recount) {
            reload();
          }
        },
        onEvent: (event) => {
          switch (event.type) {
            case "typing":
              setTypingUntil((current) => ({
                ...current,
                [event.chatId]: Date.now() + TYPING_MS,
              }));
              break;

            case "message_updated":
              setChats((current) =>
                current?.map((chat) =>
                  chat.last_message?.id === event.message.id
                    ? {
                        ...chat,
                        last_message: {
                          ...chat.last_message,
                          content: event.message.content,
                        },
                      }
                    : chat,
                ) ?? current,
              );
              break;

            case "message_deleted":
              // A deleted pinned message is unpinned.
              setChats((current) =>
                current?.map((chat) =>
                  chat.pinned_message?.id === event.messageId
                    ? { ...chat, pinned_message: null }
                    : chat,
                ) ?? current,
              );

              // The preview may need the message before it.
              if (
                chatsRef.current?.some(
                  (chat) => chat.last_message?.id === event.messageId,
                )
              ) {
                reload();
              }
              break;

            case "pinned_message":
              setChats((current) =>
                current?.map((chat) =>
                  chat.id === event.chatId ? { ...chat, pinned_message: event.message } : chat,
                ) ?? current,
              );
              break;

            case "chat_deleted":
              setChats(
                (current) =>
                  current?.filter((chat) => chat.id !== event.chatId) ?? current,
              );

              if (userId) {
                forgetCachedChat(userId, event.chatId);
              }
              break;

            case "chats_changed":
              reload();
              break;
          }
        },
        onProfile: ({ userId: changedId, username, avatarId, isDeveloper }) => {
          if (changedId === userId) {
            // Changed on another device; also refreshes the date of the
            // next allowed username change.
            withToken(api.getMe)
              .then(updateUser)
              .catch(() => {});
            return;
          }

          setChats((current) =>
            current?.map((chat) =>
              chat.user_id === changedId
                ? {
                    ...chat,
                    username,
                    avatar_id: avatarId,
                    is_developer: isDeveloper,
                  }
                : chat,
            ) ?? current,
          );
        },
      }),
    [
      subscribeEvents,
      userId,
      reload,
      sendRead,
      withToken,
      updateUser,
      chatsRef,
      viewingRef,
      privateKeyRef,
    ],
  );

  // "typing…" ends by itself.
  useEffect(() => {
    const times = Object.values(typingUntil);

    if (times.length === 0) {
      return;
    }

    const timer = setTimeout(() => {
      const now = Date.now();
      setTypingUntil((current) =>
        Object.fromEntries(Object.entries(current).filter(([, until]) => until > now)),
      );
    }, Math.max(0, Math.min(...times) - Date.now()) + 50);

    return () => clearTimeout(timer);
  }, [typingUntil]);

  const typing = useMemo(() => new Set(Object.keys(typingUntil)), [typingUntil]);

  const updateChatSettings = useCallback(
    async (chatId: string, settings: { pinned?: boolean; muted?: boolean }) => {
      setChats(
        (current) =>
          current?.map((chat) => (chat.id === chatId ? { ...chat, ...settings } : chat)) ??
          current,
      );

      try {
        await withToken((token) => api.setChatSettings(token, chatId, settings));
      } finally {
        // Pinned chats move to the top; a failed change is undone.
        await reload();
      }
    },
    [withToken, reload],
  );

  const removeChat = useCallback(
    async (chatId: string, scope: "everyone" | "me") => {
      await withToken((token) => api.deleteChat(token, chatId, scope));
      setChats((current) => current?.filter((chat) => chat.id !== chatId) ?? current);

      if (userId) {
        forgetCachedChat(userId, chatId);
      }
    },
    [withToken, userId],
  );

  const pinMessage = useCallback(
    async (chatId: string, messageId: string | null) => {
      const message = await withToken((token) => api.setPinnedMessage(token, chatId, messageId));
      setChats(
        (current) =>
          current?.map((chat) => (chat.id === chatId ? { ...chat, pinned_message: message } : chat)) ??
          current,
      );
    },
    [withToken],
  );

  // Mobile: register for push notifications; tapping one opens its chat.
  useEffect(() => {
    if (userId && privateKey) {
      syncPushToken(withToken);
    }
  }, [userId, privateKey, withToken]);

  useNotificationTaps(openChat);

  const addChat = useCallback((chat: Chat) => {
    setChats((current) =>
      current && !current.some((c) => c.id === chat.id)
        ? [chat, ...current]
        : current,
    );
  }, []);

  const setPeerReadAt = useCallback(
    (chatId: string, lastReadAt: string | null) => {
      setChats((current) =>
        current?.map((chat) =>
          chat.id === chatId
            ? {
                ...chat,
                peer_last_read_at: later(chat.peer_last_read_at, lastReadAt),
              }
            : chat,
        ) ?? current,
      );
    },
    [],
  );

  const totalUnread = useMemo(
    () => (chats ?? []).reduce((sum, chat) => sum + chat.unread_count, 0),
    [chats],
  );

  // Web: unread count in the tab title.
  const baseTitle = useRef<string | null>(null);
  useEffect(() => {
    if (Platform.OS !== "web") {
      return;
    }

    baseTitle.current ??= document.title || "Ostrich";
    document.title =
      totalUnread > 0 ? `(${totalUnread}) ${baseTitle.current}` : baseTitle.current;
  }, [totalUnread]);

  return (
    <ChatsContext
      value={{
        chats,
        synced,
        error,
        reload,
        totalUnread,
        addChat,
        setActiveChat: setActiveChatId,
        markChatRead,
        setPeerReadAt,
        typing,
        updateChatSettings,
        removeChat,
        drafts,
        setDraft,
        pinMessage,
      }}
    >
      {children}
    </ChatsContext>
  );
}

export function useChats() {
  const context = useContext(ChatsContext);

  if (!context) {
    throw new Error("useChats must be used inside ChatsProvider");
  }

  return context;
}
