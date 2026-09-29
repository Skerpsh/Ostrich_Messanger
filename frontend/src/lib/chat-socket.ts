import { Platform } from "react-native";
import type { Message } from "./api";
import { WS_URL } from "./config";

const RECONNECT_DELAY_MS = 3_000;

export type SocketStatus = "connecting" | "online" | "offline";

type Handlers = {
  onStatus: (status: SocketStatus) => void;
  // Called after every (re)join, so the screen can reload missed history.
  onJoined: () => void;
  onMessage: (message: Message) => void;
  onError: (error: string) => void;
  // Called after a disconnect; return false to stop reconnecting
  // (e.g. the session has expired).
  shouldReconnect: () => Promise<boolean>;
};

// Live connection to one chat. Reconnects automatically until closed.
export class ChatSocket {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    private token: string,
    private chatId: string,
    private handlers: Handlers,
  ) {}

  connect() {
    if (this.closed) {
      return;
    }

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

    socket.onmessage = (event) => {
      let data: {
        type?: string;
        chatId?: string;
        message?: Message;
        error?: string;
      };

      try {
        data = JSON.parse(String(event.data));
      } catch {
        return;
      }

      switch (data.type) {
        case "connected":
          socket.send(JSON.stringify({ type: "join", chatId: this.chatId }));
          break;

        case "joined":
          this.handlers.onStatus("online");
          this.handlers.onJoined();
          break;

        case "message":
          if (data.message && data.message.chat_id === this.chatId) {
            this.handlers.onMessage(data.message);
          }
          break;

        case "error":
          this.handlers.onError(data.error || "Server error");
          break;
      }
    };

    socket.onclose = () => {
      if (this.socket !== socket || this.closed) {
        return;
      }

      this.socket = null;
      this.handlers.onStatus("offline");
      this.scheduleReconnect();
    };
  }

  close() {
    this.closed = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.socket?.close();
    this.socket = null;
  }

  private async scheduleReconnect() {
    if (!(await this.handlers.shouldReconnect()) || this.closed) {
      return;
    }

    this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
  }
}
