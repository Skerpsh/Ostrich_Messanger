import type { WebSocket } from "ws";

// Sockets subscribed to each chat. Kept in memory, so the backend must run
// as a single process.
const chatSockets = new Map<string, Set<WebSocket>>();

export function subscribe(chatId: string, socket: WebSocket) {
  let sockets = chatSockets.get(chatId);

  if (!sockets) {
    sockets = new Set();
    chatSockets.set(chatId, sockets);
  }

  sockets.add(socket);
}

export function unsubscribeAll(socket: WebSocket) {
  for (const [chatId, sockets] of chatSockets) {
    sockets.delete(socket);

    if (sockets.size === 0) {
      chatSockets.delete(chatId);
    }
  }
}

export function broadcast(chatId: string, payload: unknown) {
  const sockets = chatSockets.get(chatId);

  if (!sockets) {
    return;
  }

  const data = JSON.stringify(payload);

  for (const socket of sockets) {
    if (socket.readyState === socket.OPEN) {
      socket.send(data);
    }
  }
}
