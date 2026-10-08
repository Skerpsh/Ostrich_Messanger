// SQL conditions shared by the routes: blocks and presence. The arguments
// are SQL expressions (column names or $n parameters), never user input.

// Whether users `a` and `b` have blocked each other, in either direction.
export function blockedEitherWay(a: string, b: string) {
  return `EXISTS (
    SELECT 1 FROM blocks
    WHERE (blocks.blocker_id = ${a} AND blocks.blocked_id = ${b})
       OR (blocks.blocker_id = ${b} AND blocks.blocked_id = ${a})
  )`;
}

// Whether `viewer` may see the presence (online, last seen) of the user
// row `target` (an alias of "users") through the chat `chatId`: the target
// shows their presence, neither blocked the other, and the target has
// written in the chat (not counting group events). The last condition means that starting a chat with
// someone does not reveal when they are online: they have to answer first.
export function presenceVisible(target: string, viewer: string, chatId: string) {
  return `(
    ${target}.show_presence
    AND NOT ${blockedEitherWay(viewer, `${target}.id`)}
    AND EXISTS (
      SELECT 1 FROM messages presence_message
      WHERE presence_message.chat_id = ${chatId}
        AND presence_message.sender_id = ${target}.id
        AND presence_message.kind = 'text'
    )
  )`;
}
