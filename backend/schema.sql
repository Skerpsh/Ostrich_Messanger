-- Ostrich database schema.
-- Idempotent: safe to run on an empty database and on an existing one
-- (npm run db:migrate).

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      VARCHAR(32) NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Databases created before this file existed may lack columns that the
-- CREATE TABLE statements here have (CREATE TABLE IF NOT EXISTS leaves an
-- existing table as it is): add them.
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- When the user was last connected (for "last seen"); NULL if never.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

-- Users find each other by @username; the numeric login_id is gone.
ALTER TABLE users DROP COLUMN IF EXISTS login_id;

-- SHA-256 of the user's OstrichID, the second secret needed to log in.
-- NULL for accounts created before OstrichIDs: they get one at their
-- next login.
ALTER TABLE users ADD COLUMN IF NOT EXISTS ostrich_id_hash TEXT;

-- End-to-end encryption. The OstrichID never reaches the server: clients
-- derive from it an auth key (only its SHA-256 is stored here, replacing
-- ostrich_id_hash) and a key that encrypts the account's X25519 private
-- key. The server keeps the public key and the encrypted private key, so
-- every device that knows the OstrichID can read the account's chats.
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_key_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS public_key TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS encrypted_private_key TEXT;

-- Privacy: whether others see the user online / last seen, and whether
-- read receipts are exchanged (off works both ways: the user neither
-- sends nor sees them).
ALTER TABLE users ADD COLUMN IF NOT EXISTS show_presence BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS read_receipts BOOLEAN NOT NULL DEFAULT TRUE;

-- Last username change; NULL if never changed (the first change after
-- registration is allowed right away, then once per 28 days).
ALTER TABLE users ADD COLUMN IF NOT EXISTS username_changed_at TIMESTAMPTZ;

-- Usernames are unique case-insensitively ("Alice" and "alice" are the
-- same user), which also protects registration from races.
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_key
  ON users (LOWER(username));

CREATE TABLE IF NOT EXISTS sessions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);

-- Which app the session is from ("web", "ios", "android", "cli", ...) and
-- when it was last used, for the list of devices in Settings.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS client TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS chats (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type       VARCHAR(20) NOT NULL DEFAULT 'direct',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chat_members (
  chat_id   UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chat_id, user_id)
);

ALTER TABLE chats ADD COLUMN IF NOT EXISTS type VARCHAR(20) NOT NULL DEFAULT 'direct';
ALTER TABLE chats ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE chats ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE chat_members ADD COLUMN IF NOT EXISTS joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS chat_members_user_id_idx ON chat_members (user_id);

-- How far the member has read the chat: messages created after it are
-- unread. Existing members start with everything read.
ALTER TABLE chat_members
  ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE TABLE IF NOT EXISTS messages (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id    UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sender_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS messages_chat_id_created_at_idx
  ON messages (chat_id, created_at);

-- Set when the sender edits the message.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;

-- One reaction per user and message, from a fixed set of emoji. Not
-- encrypted: the server sees which emoji, like it sees who wrote when.
CREATE TABLE IF NOT EXISTS message_reactions (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, user_id)
);

-- Per member: chats pinned to the top of the list, and muted chats (no
-- notifications).
ALTER TABLE chat_members ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ;
ALTER TABLE chat_members ADD COLUMN IF NOT EXISTS muted BOOLEAN NOT NULL DEFAULT FALSE;

-- The message this one replies to (same chat); NULL if not a reply.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS reply_to_id UUID REFERENCES messages(id) ON DELETE SET NULL;

-- Developer accounts get a "DEV" badge next to their name. Set only from
-- the server's command line (npm run dev-badge), never through the API.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_developer BOOLEAN NOT NULL DEFAULT FALSE;

-- Blocks: the blocked user cannot message the blocker or start a chat
-- with them, and neither sees the other's online status.
CREATE TABLE IF NOT EXISTS blocks (
  blocker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (blocker_id, blocked_id)
);

CREATE INDEX IF NOT EXISTS blocks_blocked_id_idx ON blocks (blocked_id);

-- Profile pictures: 512x512 WebP, re-encoded by the server (no metadata).
-- The id is random and new for every upload, so it works as an
-- unguessable, cacheable URL (/api/avatars/:id) that only reaches other
-- users through authenticated API responses.
CREATE TABLE IF NOT EXISTS avatars (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  image      BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Push notification tokens (Expo) of the apps, one per session: logging
-- out removes it with the session.
CREATE TABLE IF NOT EXISTS push_tokens (
  session_id UUID PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  token      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
