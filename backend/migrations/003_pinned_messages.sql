-- The message pinned at the top of a chat, the same for both members;
-- NULL if none. Deleting the message unpins it.
ALTER TABLE chats
  ADD COLUMN pinned_message_id UUID REFERENCES messages(id) ON DELETE SET NULL;
