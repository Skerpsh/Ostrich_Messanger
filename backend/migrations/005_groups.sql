-- Groups (chats.type 'group'): up to 50 members with roles. Their name and
-- photo are encrypted with the group key (encrypted_info), which the
-- server never has: each member gets it wrapped for them (group_keys),
-- one key per epoch; a new epoch follows when someone leaves or is
-- removed, so they cannot read what comes after.
ALTER TABLE chat_members
  ADD COLUMN role TEXT NOT NULL DEFAULT 'member'
  CHECK (role IN ('owner', 'admin', 'member'));

ALTER TABLE chats ADD COLUMN encrypted_info TEXT;

-- The epoch of the current group key; 0 for direct chats.
ALTER TABLE chats ADD COLUMN key_epoch INTEGER NOT NULL DEFAULT 0;

-- Someone left: the next member to write makes a new key first.
ALTER TABLE chats ADD COLUMN rotation_needed BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE group_keys (
  chat_id            UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  epoch              INTEGER NOT NULL,
  wrapped_key        TEXT NOT NULL,
  -- Who wrapped it; their public key opens it (also once they are gone).
  wrapper_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  wrapper_public_key TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chat_id, user_id, epoch)
);

-- Messages the server writes about a group ("alice added bob"): kind
-- 'system', content plain JSON. They only say what the server knows
-- anyway (who is in the group), never the group's name.
ALTER TABLE messages
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'
  CHECK (kind IN ('text', 'system'));

-- A group's photo is an attachment of the chat rather than of a message.
ALTER TABLE attachments
  ADD COLUMN chat_id UUID REFERENCES chats(id) ON DELETE CASCADE;
