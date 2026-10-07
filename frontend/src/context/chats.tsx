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
import { useAuth } from "@/context/auth";
import { useRealtime } from "@/context/realtime";
import * as api from "@/lib/api";
import type { Chat, Message } from "@/lib/api";

type ChatsContextValue = {
  // null until the first load.
  chats: Chat[] | null;
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
};

const ChatsContext = createContext<ChatsContextValue | null>(null);

const later = (a: string | null, b: string | null) =>
  !a ? b : !b ? a : new Date(a) >= new Date(b) ? a : b;

const isAfter = (a: string, b: string | null) =>
  !b || new Date(a).getTime() > new Date(b).getTime();

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
  const { status, seedPresence, subscribeEvents } = useRealtime();
  const userId = state.status === "signedIn" ? state.user.id : null;

  const [chats, setChats] = useState<Chat[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const visible = useAppVisible();

  const chatsRef = useRef(chats);
  chatsRef.current = chats;
  const viewingRef = useRef<string | null>(null);
  viewingRef.current = visible ? activeChatId : null;

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
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load chats");
    }
  }, [withToken, seedPresence]);

  // Reloading after every (re)connect also picks up what was missed.
  useEffect(() => {
    if (!userId) {
      setChats(null);
      return;
    }

    if (status === "online" || chatsRef.current === null) {
      reload();
    }
  }, [userId, status, reload]);

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
    [sendRead, userId],
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
  }, [visible, activeChatId, sendRead]);

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
                content: message.content.slice(0, 200),
                created_at: message.created_at,
              },
              unread_count:
                incoming && !viewing ? chat.unread_count + 1 : chat.unread_count,
            };

            // Most recently active first.
            return [updated, ...current.filter((c) => c.id !== chat.id)];
          });

          if (incoming && viewing) {
            sendRead(message.chat_id, message.id);
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
    [subscribeEvents, userId, reload, sendRead, withToken, updateUser],
  );

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
        error,
        reload,
        totalUnread,
        addChat,
        setActiveChat: setActiveChatId,
        markChatRead,
        setPeerReadAt,
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
