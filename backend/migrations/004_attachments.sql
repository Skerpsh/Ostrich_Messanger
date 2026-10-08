-- Files sent in messages. Clients encrypt them (each with its own key,
-- which travels inside the end-to-end encrypted message), so the server
-- keeps only ciphertext: in ATTACHMENTS_DIR, named by the id the client
-- chose. A file is linked to its message when the message is sent; only
-- members of that chat can download it. Deleting the message (or chat, or
-- account) deletes the row, and the file goes with the next cleanup;
-- uploads never sent are removed after a day.
CREATE TABLE attachments (
  id          UUID PRIMARY KEY,
  uploader_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id  UUID REFERENCES messages(id) ON DELETE CASCADE,
  size        INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX attachments_message_id_idx ON attachments (message_id);

CREATE INDEX attachments_unlinked_idx ON attachments (created_at)
  WHERE message_id IS NULL;
