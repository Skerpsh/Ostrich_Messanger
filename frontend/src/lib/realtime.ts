import { Platform } from "react-native";
import type { Message } from "./api";
import { WS_URL } from "./config";

const RECONNECT_DELAY_MS = 3_000;

export type ConnectionStatus = "connecting" | "online" | "offline";

export type PresenceEvent = {
  userId: string;
  online: boolean;
  lastSeenAt: string | null;
};

type Handlers = {
  onStatus: (status: ConnectionStatus) => void;
  // Called after every (re)join, so screens can reload missed history.
  onJoined: (chatId: string) => void;
  onMessage: (message: Message) => void;
  onPresence: (event: PresenceEvent) => void;
  onError: (error: string) => void;
  // Called after a disconnect; return false to stop reconnecting
  // (e.g. the session has expired).
  shouldReconnect: () => Promise<boolean>;
};

// One websocket for the whole session: while it is open the user is shown
// as online to their contacts. Chats are joined to receive their messages;
// joined chats are re-joined automatically after a reconnect.
export class RealtimeConnection {
  private socket: WebSocket | null = null;
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

  private open() {
    this.handlers.onStatus("connecting");

    let socket: WebSocket;

    if (Platform.OS === "web") {
      // Browsers cannot set headers on websockets.
      socket = new WebSocket(
        `${WS_URL}?token=${encodeURIComponent(this.token)}`,
      );
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

    if (!this.running || this.socket || this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;

      if (this.running && !this.socket) {
        this.open();
      }
    }, RECONNECT_DELAY_MS);
  }
}
