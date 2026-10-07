-- A member's chat is hidden from their chats list until it gets a message
-- or they open it themselves. New chats start hidden for the member who
-- did not start them, so strangers cannot fill someone's chats list with
-- empty chats; "clear history" hides the chat as well.
ALTER TABLE chat_members
  ADD COLUMN hidden BOOLEAN NOT NULL DEFAULT FALSE;

-- "Clear history for me": messages up to this time are hidden from the
-- member (the other member keeps them). NULL if never cleared.
ALTER TABLE chat_members ADD COLUMN cleared_at TIMESTAMPTZ;

-- Whether a user has written in a chat decides if the other member sees
-- their presence (see backend/src/visibility.ts).
CREATE INDEX messages_chat_id_sender_id_idx ON messages (chat_id, sender_id);

-- Usernames given up by a username change stay reserved for their former
-- owner for a while, so nobody can take one over and pose as them.
CREATE TABLE username_reservations (
  username_lower TEXT PRIMARY KEY,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reserved_until TIMESTAMPTZ NOT NULL
);

CREATE INDEX username_reservations_until_idx
  ON username_reservations (reserved_until);
