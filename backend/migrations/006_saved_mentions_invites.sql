-- "Saved messages": a chat of the user with themselves (chats.type
-- 'saved'), encrypted like a direct chat with their own key.
ALTER TABLE users
  ADD COLUMN saved_chat_id UUID REFERENCES chats(id) ON DELETE SET NULL;

-- Who a group message mentions (@username). The text is encrypted, so the
-- sender's app says it; the server only learns who, to notify them even
-- in a muted group.
CREATE TABLE message_mentions (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, user_id)
);

CREATE INDEX message_mentions_user_id_idx ON message_mentions (user_id);

-- A group's invite link (one at a time): whoever opens it asks to join,
-- and an admin lets them in (their app hands over the group key). The
-- token only allows asking, so admins can show the link again.
CREATE TABLE group_invites (
  chat_id    UUID PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  token      TEXT NOT NULL UNIQUE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE group_join_requests (
  chat_id    UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chat_id, user_id)
);

CREATE INDEX group_join_requests_user_id_idx ON group_join_requests (user_id);
