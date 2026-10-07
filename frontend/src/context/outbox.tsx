import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "@/context/auth";
import { useRealtime } from "@/context/realtime";
import * as api from "@/lib/api";
import type { Message, ReplyPreview } from "@/lib/api";
import { useLatest } from "@/lib/use-latest";

// Messages on their way: shown in the chat at once with a clock, sent in
// the background, and kept and sent again while there is no network. The
// client chooses each message's id, so sending one twice is harmless (the
// server answers 409 for the second).

const RETRY_MS = 15_000;

export type Outgoing = {
  id: string;
  chatId: string;
  senderId: string;
  // Encrypted.
  content: string;
  replyTo: ReplyPreview | null;
  createdAt: string;
  // "sending": in flight or waiting for the network; "failed": refused.
  state: "sending" | "failed";
  error?: string;
};

type OutboxValue = {
  outgoing: Outgoing[];
  send: (item: Omit<Outgoing, "state" | "createdAt">) => void;
  retry: (id: string) => void;
  discard: (id: string) => void;
  // Called with each message the server has accepted.
  subscribeSent: (listener: (message: Message) => void) => () => void;
};

const OutboxContext = createContext<OutboxValue | null>(null);

// A pending message as the chat shows it.
export function outgoingAsMessage(item: Outgoing): Message & { outgoing: Outgoing } {
  return {
    id: item.id,
    chat_id: item.chatId,
    sender_id: item.senderId,
    sender_username: "",
    content: item.content,
    created_at: item.createdAt,
    edited_at: null,
    reply_to: item.replyTo,
    reactions: [],
    outgoing: item,
  };
}

export function OutboxProvider({ children }: { children: ReactNode }) {
  const { state, withToken } = useAuth();
  const { status } = useRealtime();
  const userId = state.status === "signedIn" ? state.user.id : null;

  const [outgoing, setOutgoing] = useState<Outgoing[]>([]);
  const outgoingRef = useLatest(outgoing);
  const inFlight = useRef(new Set<string>());
  const sentListeners = useRef(new Set<(message: Message) => void>());

  // Another account: drop the previous one's queue.
  const [owner, setOwner] = useState(userId);

  if (owner !== userId) {
    setOwner(userId);
    setOutgoing([]);
  }

  const update = useCallback((id: string, change: Partial<Outgoing> | null) => {
    setOutgoing((current) =>
      change === null
        ? current.filter((item) => item.id !== id)
        : current.map((item) => (item.id === id ? { ...item, ...change } : item)),
    );
  }, []);

  const attempt = useCallback(
    (item: Outgoing) => {
      if (inFlight.current.has(item.id)) {
        return;
      }

      inFlight.current.add(item.id);

      withToken((token) =>
        api.sendMessage(token, item.chatId, {
          id: item.id,
          content: item.content,
          replyTo: item.replyTo?.id ?? null,
        }),
      )
        .then((message) => {
          update(item.id, null);

          for (const listener of sentListeners.current) {
            listener(message);
          }
        })
        .catch((e) => {
          if (!(e instanceof api.ApiError)) {
            update(item.id, { state: "failed", error: "Something went wrong" });
          } else if (e.status === 409) {
            // Sent before; the answer got lost. The history has it.
            update(item.id, null);
          } else if (e.status === 0) {
            // No network: stays queued.
          } else {
            update(item.id, { state: "failed", error: e.message });
          }
        })
        .finally(() => inFlight.current.delete(item.id));
    },
    [withToken, update],
  );

  const send = useCallback(
    (item: Omit<Outgoing, "state" | "createdAt">) => {
      const full: Outgoing = { ...item, state: "sending", createdAt: new Date().toISOString() };
      setOutgoing((current) => [...current, full]);
      attempt(full);
    },
    [attempt],
  );

  const retry = useCallback(
    (id: string) => {
      const item = outgoingRef.current.find((o) => o.id === id);

      if (item) {
        update(id, { state: "sending", error: undefined });
        attempt({ ...item, state: "sending" });
      }
    },
    [attempt, update, outgoingRef],
  );

  const discard = useCallback((id: string) => update(id, null), [update]);

  // Back online, and every little while: send what is waiting.
  useEffect(() => {
    const flush = () => {
      for (const item of outgoingRef.current) {
        if (item.state === "sending") {
          attempt(item);
        }
      }
    };

    if (status === "online") {
      flush();
    }

    const timer = setInterval(flush, RETRY_MS);

    return () => clearInterval(timer);
  }, [status, attempt, outgoingRef]);

  const subscribeSent = useCallback((listener: (message: Message) => void) => {
    sentListeners.current.add(listener);

    return () => {
      sentListeners.current.delete(listener);
    };
  }, []);

  return (
    <OutboxContext value={{ outgoing, send, retry, discard, subscribeSent }}>
      {children}
    </OutboxContext>
  );
}

export function useOutbox() {
  const context = useContext(OutboxContext);

  if (!context) {
    throw new Error("useOutbox must be used inside OutboxProvider");
  }

  return context;
}
