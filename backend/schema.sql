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

-- When the user was last connected (for "last seen"); NULL if never.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

-- Users find each other by @username; the numeric login_id is gone.
ALTER TABLE users DROP COLUMN IF EXISTS login_id;

-- SHA-256 of the user's OstrichID, the second secret needed to log in.
-- NULL for accounts created before OstrichIDs: they get one at their
-- next login.
ALTER TABLE users ADD COLUMN IF NOT EXISTS ostrich_id_hash TEXT;

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

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
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

CREATE INDEX IF NOT EXISTS messages_chat_id_created_at_idx
  ON messages (chat_id, created_at);

-- The message this one replies to (same chat); NULL if not a reply.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS reply_to_id UUID REFERENCES messages(id) ON DELETE SET NULL;

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
