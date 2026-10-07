import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppState, Platform } from "react-native";
import { useAuth } from "@/context/auth";
import {
  getMe,
  getWsTicket,
  SessionExpiredError,
  type Message,
} from "@/lib/api";
import {
  RealtimeConnection,
  type ConnectionStatus,
  type PresenceEvent,
  type ReadEvent,
} from "@/lib/realtime";

export type Presence = {
  online: boolean;
  lastSeenAt: string | null;
};

type ChatListener = {
  onMessage: (message: Message) => void;
  onJoined: () => void;
};

// Receives the events of all chats (for the chats list).
export type EventListener = {
  onMessage: (message: Message) => void;
  onRead: (event: ReadEvent) => void;
};

type RealtimeContextValue = {
  status: ConnectionStatus;
  presence: Record<string, Presence>;
  // Presence from REST responses (chats list); live events override it.
  seedPresence: (entries: { userId: string; presence: Presence }[]) => void;
  // Receive a chat's messages while the returned function is not called.
  subscribeChat: (chatId: string, listener: ChatListener) => () => void;
  // Receive all chats' events while the returned function is not called.
  subscribeEvents: (listener: EventListener) => () => void;
};

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

// Keeps the session's websocket open while signed in (and, on mobile, while
// the app is in the foreground), so the user is shown online.
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { state, withToken } = useAuth();
  const token = state.status === "signedIn" ? state.token : null;

  const [status, setStatus] = useState<ConnectionStatus>("offline");
  const [presence, setPresence] = useState<Record<string, Presence>>({});

  const connectionRef = useRef<RealtimeConnection | null>(null);
  const listenersRef = useRef(new Map<string, Set<ChatListener>>());
  const eventListenersRef = useRef(new Set<EventListener>());

  useEffect(() => {
    if (!token) {
      return;
    }

    const listeners = listenersRef.current;
    const eventListeners = eventListenersRef.current;

    const connection = new RealtimeConnection(token, {
      onStatus: setStatus,
      onJoined: (chatId) => {
        for (const listener of listeners.get(chatId) ?? []) {
          listener.onJoined();
        }
      },
      onMessage: (message) => {
        for (const listener of listeners.get(message.chat_id) ?? []) {
          listener.onMessage(message);
        }

        for (const listener of eventListeners) {
          listener.onMessage(message);
        }
      },
      onRead: (event) => {
        for (const listener of eventListeners) {
          listener.onRead(event);
        }
      },
      onPresence: ({ userId, online, lastSeenAt }: PresenceEvent) =>
        setPresence((current) => ({
          ...current,
          [userId]: { online, lastSeenAt },
        })),
      // Errors only concern single requests (e.g. joining a chat that
      // does not exist); screens show their own REST errors.
      onError: () => {},
      getTicket: () => withToken(getWsTicket),
      shouldReconnect: async () => {
        try {
          await withToken(getMe);
          return true;
        } catch (e) {
          return !(e instanceof SessionExpiredError);
        }
      },
    });

    connectionRef.current = connection;

    for (const chatId of listeners.keys()) {
      connection.join(chatId);
    }

    connection.start();

    // Mobile: go offline in the background, reconnect when back.
    const subscription =
      Platform.OS === "web"
        ? null
        : AppState.addEventListener("change", (appState) => {
            if (appState === "active") {
              connection.start();
            } else if (appState === "background") {
              connection.stop();
            }
          });

    return () => {
      subscription?.remove();
      connection.stop();
      connectionRef.current = null;
      // Presence of the previous session's contacts.
      setPresence({});
    };
  }, [token, withToken]);

  const seedPresence = useCallback(
    (entries: { userId: string; presence: Presence }[]) => {
      setPresence((current) => {
        const next = { ...current };

        for (const { userId, presence } of entries) {
          next[userId] = presence;
        }

        return next;
      });
    },
    [],
  );

  const subscribeChat = useCallback(
    (chatId: string, listener: ChatListener) => {
      const listeners = listenersRef.current;
      let set = listeners.get(chatId);

      if (!set) {
        set = new Set();
        listeners.set(chatId, set);
        connectionRef.current?.join(chatId);
      }

      set.add(listener);

      return () => {
        set.delete(listener);

        if (set.size === 0) {
          listeners.delete(chatId);
          connectionRef.current?.leave(chatId);
        }
      };
    },
    [],
  );

  const subscribeEvents = useCallback((listener: EventListener) => {
    eventListenersRef.current.add(listener);

    return () => {
      eventListenersRef.current.delete(listener);
    };
  }, []);

  return (
    <RealtimeContext
      value={{ status, presence, seedPresence, subscribeChat, subscribeEvents }}
    >
      {children}
    </RealtimeContext>
  );
}

export function useRealtime() {
  const context = useContext(RealtimeContext);

  if (!context) {
    throw new Error("useRealtime must be used inside RealtimeProvider");
  }

  return context;
}

export function usePresence(userId: string | undefined): Presence | undefined {
  const { presence } = useRealtime();

  return userId ? presence[userId] : undefined;
}
