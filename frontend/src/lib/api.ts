import { API_URL } from "./config";

export type User = {
  id: string;
  username: string;
  // When the username can be changed again; null if it can be now.
  next_username_change_at: string | null;
  // null without a profile picture; see avatarUrl().
  avatar_id: string | null;
  // Shows the DEV badge.
  is_developer: boolean;
};

// Profile pictures are plain image URLs: the id is random and new for
// every upload, so they can be cached for good.
export function avatarUrl(avatarId: string) {
  return `${API_URL}/api/avatars/${encodeURIComponent(avatarId)}`;
}

export type LastMessage = {
  id: string;
  sender_id: string;
  // The start of the message (up to 200 characters), for previews.
  content: string;
  created_at: string;
};

export type Chat = {
  id: string;
  type: string;
  created_at: string;
  updated_at: string;
  user_id: string;
  username: string;
  avatar_id: string | null;
  is_developer: boolean;
  // Presence of the other user.
  online: boolean;
  last_seen_at: string | null;
  last_message: LastMessage | null;
  // Messages from the other user the signed-in user has not read.
  unread_count: number;
  // Up to when the other user has read the chat (for read receipts).
  peer_last_read_at: string | null;
};

export type ChatHistory = {
  messages: Message[];
  // Up to when the signed-in user had read the chat.
  last_read_at: string | null;
  peer_last_read_at: string | null;
};

// The message a reply refers to (its start, for the quote).
export type ReplyPreview = {
  id: string;
  sender_id: string;
  sender_username: string;
  sender_is_developer: boolean;
  content: string;
};

export type Message = {
  id: string;
  chat_id: string;
  sender_id: string;
  sender_username: string;
  content: string;
  created_at: string;
  reply_to: ReplyPreview | null;
};

export type AuthResponse = {
  token: string;
  user: User;
  // Only right after registration, or the first login of an account
  // created before OstrichIDs. Shown to the user once, never again.
  ostrich_id?: string;
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
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  options: {
    token?: string;
    body?: unknown;
    // Sent as is instead of JSON, e.g. an image.
    file?: { data: Blob; type: string };
    timeoutMs?: number;
  } = {},
): Promise<T> {
  const headers: Record<string, string> = {};

  if (options.file) {
    headers["Content-Type"] = options.file.type;
  } else if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? REQUEST_TIMEOUT_MS,
  );

  let response: Response;

  try {
    response = await fetch(API_URL + path, {
      method,
      headers,
      body: options.file
        ? options.file.data
        : options.body === undefined
          ? undefined
          : JSON.stringify(options.body),
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

export function login(username: string, password: string, ostrichId: string) {
  return request<AuthResponse>("POST", "/api/auth/login", {
    body: {
      username,
      password,
      // Left out when empty: accounts created before OstrichIDs log in
      // without one once.
      ...(ostrichId ? { ostrich_id: ostrichId } : {}),
    },
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

// Ends every session of the user, including this one.
export function logoutAll(token: string) {
  return request<unknown>("POST", "/api/auth/logout-all", { token });
}

// Changes the password and ends all other sessions.
export function changePassword(
  token: string,
  currentPassword: string,
  newPassword: string,
) {
  return request<unknown>("POST", "/api/auth/password", {
    token,
    body: { current_password: currentPassword, new_password: newPassword },
  });
}

// Allowed right after registration, then once per 28 days.
export async function changeUsername(
  token: string,
  username: string,
  password: string,
) {
  const { user } = await request<{ user: User }>(
    "POST",
    "/api/auth/username",
    { token, body: { username, password } },
  );

  return user;
}

// Single-use credential for opening the websocket from a browser.
export async function getWsTicket(token: string) {
  const { ticket } = await request<{ ticket: string }>(
    "POST",
    "/api/auth/ws-ticket",
    { token },
  );

  return ticket;
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

// Opens (or returns the existing) direct chat with the user that has
// exactly this username.
export async function createChat(token: string, username: string) {
  const { chat, user } = await request<{
    chat: { id: string; type: string; created_at: string };
    user: {
      id: string;
      username: string;
      avatar_id?: string | null;
      is_developer?: boolean;
      online?: boolean;
      last_seen_at?: string | null;
    };
  }>("POST", "/api/chats", { token, body: { username } });

  return {
    ...chat,
    updated_at: chat.created_at,
    user_id: user.id,
    username: user.username,
    avatar_id: user.avatar_id ?? null,
    is_developer: user.is_developer ?? false,
    online: user.online ?? false,
    last_seen_at: user.last_seen_at ?? null,
    last_message: null,
    unread_count: 0,
    peer_last_read_at: null,
  } satisfies Chat;
}

export function getMessages(token: string, chatId: string) {
  return request<ChatHistory>(
    "GET",
    `/api/chats/${encodeURIComponent(chatId)}/messages`,
    { token },
  );
}

// Marks the chat read up to and including the message.
export function markRead(token: string, chatId: string, messageId: string) {
  return request<{ last_read_at: string }>(
    "POST",
    `/api/chats/${encodeURIComponent(chatId)}/read`,
    { token, body: { message_id: messageId } },
  );
}

export async function sendMessage(
  token: string,
  chatId: string,
  content: string,
  // Id of the message this one replies to.
  replyTo: string | null = null,
) {
  const { message } = await request<{ message: Message }>(
    "POST",
    `/api/chats/${encodeURIComponent(chatId)}/messages`,
    {
      token,
      body: replyTo ? { content, reply_to: replyTo } : { content },
    },
  );

  return message;
}

// Sets the profile picture (the server re-encodes it to a square WebP).
export async function uploadAvatar(token: string, image: Blob) {
  const { user } = await request<{ user: User }>(
    "PUT",
    "/api/users/me/avatar",
    {
      token,
      file: { data: image, type: image.type || "image/jpeg" },
      timeoutMs: 60_000,
    },
  );

  return user;
}

export async function removeAvatar(token: string) {
  const { user } = await request<{ user: User }>(
    "DELETE",
    "/api/users/me/avatar",
    { token },
  );

  return user;
}
