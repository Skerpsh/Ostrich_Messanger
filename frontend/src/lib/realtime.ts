import { Platform } from "react-native";
import type { Message } from "./api";
import { WS_URL } from "./config";

const RECONNECT_DELAY_MS = 3_000;

export type ConnectionStatus = "connecting" | "online" | "offline";

export type ReadEvent = {
  chatId: string;
  userId: string;
  lastReadAt: string;
};

export type PresenceEvent = {
  userId: string;
  online: boolean;
  lastSeenAt: string | null;
};

// A contact (or the user, on another device) changed username or avatar.
export type ProfileEvent = {
  userId: string;
  username: string;
  avatarId: string | null;
  isDeveloper: boolean;
};

type Handlers = {
  onStatus: (status: ConnectionStatus) => void;
  // Called after every (re)join, so screens can reload missed history.
  onJoined: (chatId: string) => void;
  // Messages of all the user's chats, not only joined ones.
  onMessage: (message: Message) => void;
  onRead: (event: ReadEvent) => void;
  onProfile: (event: ProfileEvent) => void;
  onPresence: (event: PresenceEvent) => void;
  onError: (error: string) => void;
  // Web only: a single-use ticket for the websocket URL, so the session
  // token never appears in URLs.
  getTicket: () => Promise<string>;
  // Called after a disconnect; return false to stop reconnecting
  // (e.g. the session has expired).
  shouldReconnect: () => Promise<boolean>;
};

// One websocket for the whole session: while it is open the user is shown
// as online to their contacts. Chats are joined to receive their messages;
// joined chats are re-joined automatically after a reconnect.
export class RealtimeConnection {
  private socket: WebSocket | null = null;
  // Web: the connection attempt waiting for its ticket.
  private opening: object | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  // The server has accepted the connection ("connected" received).
  private ready = false;
  private chats = new Set<string>();

  constructor(
    private token: string,
    private handlers: Handlers,
  ) {}

  start() {
    if (this.running) {
      return;
    }

    this.running = true;
    this.open();
  }

  stop() {
    this.running = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const socket = this.socket;
    this.socket = null;
    this.opening = null;
    this.ready = false;
    socket?.close();
    this.handlers.onStatus("offline");
  }

  join(chatId: string) {
    this.chats.add(chatId);
    this.send({ type: "join", chatId });
  }

  leave(chatId: string) {
    this.chats.delete(chatId);
    this.send({ type: "leave", chatId });
  }

  private send(payload: unknown) {
    if (this.ready && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }

  private async open() {
    this.handlers.onStatus("connecting");

    let socket: WebSocket;

    if (Platform.OS === "web") {
      // Browsers cannot set headers on websockets.
      const attempt = {};
      this.opening = attempt;

      let ticket: string;

      try {
        ticket = await this.handlers.getTicket();
      } catch {
        if (this.opening === attempt) {
          this.opening = null;
          this.handlers.onStatus("offline");
          this.scheduleReconnect();
        }
        return;
      }

      // Stopped (or restarted) while waiting for the ticket.
      if (this.opening !== attempt) {
        return;
      }

      this.opening = null;

      socket = new WebSocket(`${WS_URL}?ticket=${encodeURIComponent(ticket)}`);
    } else {
      // React Native accepts headers as a third argument.
      const NativeWebSocket = WebSocket as unknown as new (
        url: string,
        protocols: string[] | undefined,
        options: { headers: Record<string, string> },
      ) => WebSocket;

      socket = new NativeWebSocket(WS_URL, undefined, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
    }

    this.socket = socket;
    this.ready = false;

    socket.onmessage = (event) => {
      if (this.socket !== socket) {
        return;
      }

      let data: {
        type?: string;
        chatId?: string;
        message?: Message;
        userId?: string;
        online?: boolean;
        lastSeenAt?: string | null;
        lastReadAt?: string;
        username?: string;
        avatarId?: string | null;
        isDeveloper?: boolean;
        error?: string;
      };

      try {
        data = JSON.parse(String(event.data));
      } catch {
        return;
      }

      switch (data.type) {
        case "connected":
          this.ready = true;
          this.handlers.onStatus("online");

          for (const chatId of this.chats) {
            this.send({ type: "join", chatId });
          }
          break;

        case "joined":
          if (data.chatId) {
            this.handlers.onJoined(data.chatId);
          }
          break;

        case "message":
          if (data.message) {
            this.handlers.onMessage(data.message);
          }
          break;

        case "read":
          if (data.chatId && data.userId && data.lastReadAt) {
            this.handlers.onRead({
              chatId: data.chatId,
              userId: data.userId,
              lastReadAt: data.lastReadAt,
            });
          }
          break;

        case "profile":
          if (data.userId && data.username) {
            this.handlers.onProfile({
              userId: data.userId,
              username: data.username,
              avatarId: data.avatarId ?? null,
              isDeveloper: Boolean(data.isDeveloper),
            });
          }
          break;

        case "presence":
          if (data.userId) {
            this.handlers.onPresence({
              userId: data.userId,
              online: Boolean(data.online),
              lastSeenAt: data.lastSeenAt ?? null,
            });
          }
          break;

        case "error":
          this.handlers.onError(data.error || "Server error");
          break;
      }
    };

    socket.onclose = () => {
      if (this.socket !== socket) {
        return;
      }

      this.socket = null;
      this.ready = false;
      this.handlers.onStatus("offline");
      this.scheduleReconnect();
    };
  }

  private async scheduleReconnect() {
    if (!this.running || !(await this.handlers.shouldReconnect())) {
      return;
    }

    if (!this.running || this.socket || this.opening || this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;

      if (this.running && !this.socket && !this.opening) {
        this.open();
      }
    }, RECONNECT_DELAY_MS);
  }
}
