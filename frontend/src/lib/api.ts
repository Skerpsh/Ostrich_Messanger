import { API_URL } from "./config";

export type User = {
  id: string;
  login_id: string;
  username: string;
};

export type Chat = {
  id: string;
  type: string;
  created_at: string;
  updated_at: string;
  user_id: string;
  login_id: string;
  username: string;
  // Presence of the other user.
  online: boolean;
  last_seen_at: string | null;
};

export type Message = {
  id: string;
  chat_id: string;
  sender_id: string;
  sender_username: string;
  content: string;
  created_at: string;
  // The replied-to message; null if this is not a reply.
  reply_to_id: string | null;
  reply_sender_username: string | null;
  reply_content: string | null;
};

export type AuthResponse = {
  token: string;
  user: User;
};

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

// The server rejected the session token: the user has to log in again.
export class SessionExpiredError extends ApiError {
  constructor() {
    super("Session expired, please log in again", 401);
  }
}

const REQUEST_TIMEOUT_MS = 15_000;

async function request<T>(
  method: "GET" | "POST",
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = {};

  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;

  try {
    response = await fetch(API_URL + path, {
      method,
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
  } catch {
    throw new ApiError("Can't reach the server. Check your connection.", 0);
  } finally {
    clearTimeout(timeout);
  }

  const data = await response.json().catch(() => null);

  if (response.status === 401 && options.token) {
    throw new SessionExpiredError();
  }

  if (!response.ok) {
    throw new ApiError(
      data?.error ||
        data?.message ||
        `Request failed (HTTP ${response.status})`,
      response.status,
    );
  }

  return data as T;
}

export function login(username: string, password: string) {
  return request<AuthResponse>("POST", "/api/auth/login", {
    body: { username, password },
  });
}

export function register(username: string, password: string) {
  return request<AuthResponse>("POST", "/api/auth/register", {
    body: { username, password },
  });
}

export function logout(token: string) {
  return request<unknown>("POST", "/api/auth/logout", { token });
}

export async function getMe(token: string) {
  const { user } = await request<{ user: User }>("GET", "/api/auth/me", {
    token,
  });

  return user;
}

export async function getChats(token: string) {
  const { chats } = await request<{ chats: Chat[] }>("GET", "/api/chats", {
    token,
  });

  return chats;
}

// Opens (or returns the existing) direct chat with the user.
export async function createChat(token: string, loginId: string) {
  const { chat, user } = await request<{
    chat: { id: string; type: string; created_at: string };
    user: User & { online?: boolean; last_seen_at?: string | null };
  }>("POST", "/api/chats", { token, body: { login_id: loginId } });

  return {
    ...chat,
    updated_at: chat.created_at,
    user_id: user.id,
    login_id: user.login_id,
    username: user.username,
    online: user.online ?? false,
    last_seen_at: user.last_seen_at ?? null,
  } satisfies Chat;
}

export async function getMessages(token: string, chatId: string) {
  const { messages } = await request<{ messages: Message[] }>(
    "GET",
    `/api/chats/${encodeURIComponent(chatId)}/messages`,
    { token },
  );

  return messages;
}

export async function sendMessage(
  token: string,
  chatId: string,
  content: string,
  replyToId?: string,
) {
  const { message } = await request<{ message: Message }>(
    "POST",
    `/api/chats/${encodeURIComponent(chatId)}/messages`,
    { token, body: { content, reply_to_id: replyToId } },
  );

  return message;
}
