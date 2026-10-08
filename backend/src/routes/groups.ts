import { FastifyInstance, FastifyReply } from "fastify";
import type { PoolClient } from "pg";
import { PROFILE_COLUMNS, usernameSchema } from "../accounts.js";
import { db, isPgError, PG_UNIQUE_VIOLATION, withTransaction } from "../database.js";
import {
  addSystemMessage,
  announceMessages,
  groupMembership,
  handOverOwnership,
  isAdmin,
  MAX_GROUP_MEMBERS,
  type Role,
} from "../groups.js";
import type { ChatMessage } from "../messages.js";
import { authenticate } from "../middleware/auth.js";
import { sendToChatMembers, sendToUserSockets } from "../realtime.js";

// Groups. The client makes the group key and wraps it for each member
// (frontend/src/lib/crypto.ts); the server checks who may do what and
// that every member gets the key, and keeps everything encrypted.

const groupRateLimit = {
  rateLimit: {
    max: 60,
    timeWindow: "1 minute",
  },
};

// base64 of nonce (24) + group key (32) + tag (16).
const WRAPPED_KEY = { type: "string", pattern: "^[A-Za-z0-9+/]{96}$" } as const;

// "i1:<epoch>:" + base64: the encrypted name and photo.
const ENCRYPTED_INFO = {
  type: "string",
  maxLength: 4096,
  pattern: "^i1:[0-9]{1,9}:[A-Za-z0-9+/]+={0,2}$",
} as const;

const UUID = { type: "string", format: "uuid" } as const;

const memberKeys = {
  type: "array",
  minItems: 1,
  maxItems: MAX_GROUP_MEMBERS,
  items: {
    type: "object",
    required: ["user_id", "wrapped_key"],
    properties: { user_id: UUID, wrapped_key: WRAPPED_KEY },
  },
} as const;

type MemberKey = { user_id: string; wrapped_key: string };

const chatParams = {
  type: "object",
  required: ["chatId"],
  properties: { chatId: UUID },
} as const;

const epochOf = (encryptedInfo: string) => Number(/^i1:([0-9]+):/.exec(encryptedInfo)![1]);

class Refused extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// Runs a group change; a Refused answers with its status.
async function change<T>(reply: FastifyReply, work: (client: PoolClient) => Promise<T>) {
  try {
    return await withTransaction(work);
  } catch (error) {
    if (error instanceof Refused) {
      reply.status(error.status).send({ error: error.message });
      return null;
    }

    throw error;
  }
}

// Stores the wrapped keys of an epoch; the wrapper's public key is kept
// with them (it opens them).
async function storeKeys(client: PoolClient, chatId: string, epoch: number, wrapperId: string, keys: MemberKey[]) {
  await client.query(
    `
    INSERT INTO group_keys (chat_id, user_id, epoch, wrapped_key, wrapper_id, wrapper_public_key)
    SELECT $1, k.user_id, $2, k.wrapped_key, $3, wrapper.public_key
    FROM jsonb_to_recordset($4::jsonb) AS k(user_id uuid, wrapped_key text)
    JOIN users wrapper ON wrapper.id = $3
    `,
    [chatId, epoch, wrapperId, JSON.stringify(keys)],
  );
}

// Checks that keys go to exactly the given users.
function coversExactly(keys: MemberKey[], userIds: string[]) {
  const wanted = new Set(userIds.map((id) => id.toLowerCase()));
  const given = new Set(keys.map((k) => k.user_id.toLowerCase()));

  return given.size === keys.length && given.size === wanted.size && [...given].every((id) => wanted.has(id));
}

async function memberIds(client: PoolClient, chatId: string): Promise<string[]> {
  const result = await client.query("SELECT user_id FROM chat_members WHERE chat_id = $1", [chatId]);
  return result.rows.map((row) => row.user_id);
}

async function usernames(client: PoolClient, ids: string[]) {
  const result = await client.query("SELECT id, username FROM users WHERE id = ANY($1::uuid[])", [ids]);
  return result.rows as { id: string; username: string }[];
}

// The members (and their devices) reload the chats list; a message goes
// with it.
async function announce(chatId: string, messages: ChatMessage[], alsoUsers: string[] = []) {
  await announceMessages(messages);
  await sendToChatMembers(chatId, { type: "chats_changed" });

  for (const userId of alsoUsers) {
    sendToUserSockets(userId, { type: "chats_changed" });
  }
}

export default async function groupsRoutes(server: FastifyInstance) {
  // FIND a user by their exact @username, with their public key (to wrap
  // a group key for them).
  server.get<{ Params: { username: string } }>(
    "/api/users/by-username/:username",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        params: { type: "object", required: ["username"], properties: { username: usernameSchema } },
      },
    },
    async (request, reply) => {
      const result = await db.query(
        `SELECT id, username, public_key, ${PROFILE_COLUMNS} FROM users WHERE LOWER(username) = LOWER($1)`,
        [request.params.username],
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: "User not found" });
      }

      return { user: result.rows[0] };
    },
  );

  // CREATE a group: its id (chosen by the client, the encryption is bound
  // to it), the encrypted name, and the first key wrapped for every member
  // including the creator.
  server.post<{ Body: { id: string; encrypted_info: string; keys: MemberKey[] } }>(
    "/api/groups",
    {
      preHandler: authenticate,
      config: groupRateLimit,
      schema: {
        body: {
          type: "object",
          required: ["id", "encrypted_info", "keys"],
          properties: { id: UUID, encrypted_info: ENCRYPTED_INFO, keys: memberKeys },
        },
      },
    },
    async (request, reply) => {
      const { id, encrypted_info, keys } = request.body;
      const me = request.user.id;
      const others = [...new Set(keys.map((k) => k.user_id.toLowerCase()))].filter((u) => u !== me.toLowerCase());

      if (epochOf(encrypted_info) !== 1 || !coversExactly(keys, [me, ...others])) {
        return reply.status(400).send({ error: "The group's first key must go to every member" });
      }

      const done = await change(reply, async (client) => {
        // Members must exist and have keys, and not have blocked the
        // creator.
        const found = await client.query(
          `
          SELECT id FROM users
          WHERE id = ANY($1::uuid[])
            AND public_key IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM blocks WHERE blocker_id = users.id AND blocked_id = $2)
          `,
          [others, me],
        );

        if (found.rows.length !== others.length) {
          throw new Refused(400, "Some of these users cannot be added");
        }

        try {
          await client.query(
            "INSERT INTO chats (id, type, encrypted_info, key_epoch) VALUES ($1, 'group', $2, 1)",
            [id, encrypted_info],
          );
        } catch (error) {
          if (isPgError(error, PG_UNIQUE_VIOLATION)) {
            throw new Refused(409, "A chat with this id already exists");
          }

          throw error;
        }

        await client.query(
          `
          INSERT INTO chat_members (chat_id, user_id, role)
          SELECT $1, u, CASE WHEN u = $2 THEN 'owner' ELSE 'member' END
          FROM unnest($3::uuid[]) AS u
          `,
          [id, me, [me, ...others]],
        );

        await storeKeys(client, id, 1, me, keys);

        return [await addSystemMessage(client, id, me, { type: "created" })];
      });

      if (!done) {
        return;
      }

      await announce(id, done);

      return reply.status(201).send({ chat: { id, type: "group" } });
    },
  );

  // MEMBERS of a group, with roles and public keys.
  server.get<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/members",
    { preHandler: authenticate, schema: { params: chatParams } },
    async (request, reply) => {
      if (!(await groupMembership(request.params.chatId, request.user.id))) {
        return reply.status(404).send({ error: "Group not found" });
      }

      const result = await db.query(
        `
        SELECT users.id, users.username, users.public_key, ${PROFILE_COLUMNS},
               chat_members.role, chat_members.joined_at
        FROM chat_members
        JOIN users ON users.id = chat_members.user_id
        WHERE chat_members.chat_id = $1
        ORDER BY CASE chat_members.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
                 LOWER(users.username)
        `,
        [request.params.chatId],
      );

      return { members: result.rows };
    },
  );

  // KEYS of a group wrapped for this user, every epoch since they joined.
  server.get<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/keys",
    { preHandler: authenticate, schema: { params: chatParams } },
    async (request, reply) => {
      if (!(await groupMembership(request.params.chatId, request.user.id))) {
        return reply.status(404).send({ error: "Group not found" });
      }

      const result = await db.query(
        `
        SELECT epoch, wrapped_key, wrapper_id, wrapper_public_key
        FROM group_keys
        WHERE chat_id = $1 AND user_id = $2
        ORDER BY epoch
        `,
        [request.params.chatId, request.user.id],
      );

      return { keys: result.rows };
    },
  );

  // ADD a member (admins), with the current key wrapped for them. New
  // members see the group's messages from now on.
  server.post<{ Params: { chatId: string }; Body: { user_id: string; wrapped_key: string; epoch: number } }>(
    "/api/chats/:chatId/members",
    {
      preHandler: authenticate,
      config: groupRateLimit,
      schema: {
        params: chatParams,
        body: {
          type: "object",
          required: ["user_id", "wrapped_key", "epoch"],
          properties: { user_id: UUID, wrapped_key: WRAPPED_KEY, epoch: { type: "integer", minimum: 1 } },
        },
      },
    },
    async (request, reply) => {
      const { chatId } = request.params;
      const { user_id: userId, wrapped_key, epoch } = request.body;
      const me = request.user.id;

      const done = await change(reply, async (client) => {
        const membership = await groupMembership(chatId, me, client);

        if (!membership || !isAdmin(membership.role)) {
          throw new Refused(403, "Only the group's admins can add members");
        }

        if (epoch !== membership.key_epoch || membership.rotation_needed) {
          throw new Refused(409, "The group key has changed: load it and try again");
        }

        // One add at a time per group (the member count below).
        await client.query("SELECT 1 FROM chats WHERE id = $1 FOR UPDATE", [chatId]);

        const count = await client.query("SELECT COUNT(*)::int AS n FROM chat_members WHERE chat_id = $1", [chatId]);

        if (count.rows[0].n >= MAX_GROUP_MEMBERS) {
          throw new Refused(400, `A group can have up to ${MAX_GROUP_MEMBERS} members`);
        }

        const user = await client.query(
          `
          SELECT id, username FROM users
          WHERE id = $1
            AND public_key IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM blocks WHERE blocker_id = users.id AND blocked_id = $2)
          `,
          [userId, me],
        );

        if (user.rows.length === 0) {
          throw new Refused(400, "This user cannot be added");
        }

        try {
          await client.query("INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, 'member')", [
            chatId,
            userId,
          ]);
        } catch (error) {
          if (isPgError(error, PG_UNIQUE_VIOLATION)) {
            throw new Refused(409, "Already in the group");
          }

          throw error;
        }

        await storeKeys(client, chatId, epoch, me, [{ user_id: userId, wrapped_key }]);

        return [await addSystemMessage(client, chatId, me, { type: "added", users: user.rows })];
      });

      if (!done) {
        return;
      }

      await announce(chatId, done);

      return { added: true };
    },
  );

  // REMOVE a member, or LEAVE (the user themselves). Removing someone
  // comes with the group's next key for the others (new_keys), so the
  // removed member cannot read what follows; when someone leaves, the next
  // member to write makes it. The owner leaving hands the group over (to
  // the longest-serving admin, else member); the last one out deletes it.
  server.delete<{
    Params: { chatId: string; userId: string };
    Body: { epoch?: number; keys?: MemberKey[]; encrypted_info?: string } | undefined;
  }>(
    "/api/chats/:chatId/members/:userId",
    {
      preHandler: authenticate,
      config: groupRateLimit,
      schema: {
        params: { type: "object", required: ["chatId", "userId"], properties: { chatId: UUID, userId: UUID } },
        body: {
          anyOf: [
            { type: "null" },
            {
              type: "object",
              properties: {
                epoch: { type: "integer", minimum: 2 },
                keys: memberKeys,
                encrypted_info: ENCRYPTED_INFO,
              },
            },
          ],
        },
      },
    },
    async (request, reply) => {
      const { chatId, userId } = request.params;
      const me = request.user.id;
      const leaving = userId.toLowerCase() === me.toLowerCase();
      const rotation = request.body ?? {};

      const done = await change(reply, async (client) => {
        await client.query("SELECT 1 FROM chats WHERE id = $1 FOR UPDATE", [chatId]);

        const membership = await groupMembership(chatId, me, client);
        const target = await groupMembership(chatId, userId, client);

        if (!membership || !target) {
          throw new Refused(404, "Not in the group");
        }

        if (!leaving) {
          const allowed =
            membership.role === "owner" || (membership.role === "admin" && target.role === "member");

          if (!allowed) {
            throw new Refused(403, "You cannot remove this member");
          }
        }

        const [removed] = await usernames(client, [userId]);
        await client.query("DELETE FROM chat_members WHERE chat_id = $1 AND user_id = $2", [chatId, userId]);
        await client.query("DELETE FROM group_keys WHERE chat_id = $1 AND user_id = $2", [chatId, userId]);

        const rest = await memberIds(client, chatId);

        if (rest.length === 0) {
          await client.query("DELETE FROM chats WHERE id = $1", [chatId]);
          return { messages: [], deleted: true };
        }

        const messages: ChatMessage[] = [];

        if (target.role === "owner") {
          const heir = await handOverOwnership(client, chatId);

          if (heir) {
            messages.push(await addSystemMessage(client, chatId, heir.id, { type: "owner", user: heir }));
          }
        }

        // The next key: now (removing), or by the next member to write.
        if (!leaving && rotation.keys && rotation.encrypted_info && rotation.epoch) {
          if (rotation.epoch !== membership.key_epoch + 1 || epochOf(rotation.encrypted_info) !== rotation.epoch) {
            throw new Refused(409, "The group key has changed: load it and try again");
          }

          if (!coversExactly(rotation.keys, rest)) {
            throw new Refused(400, "The new key must go to every member");
          }

          await storeKeys(client, chatId, rotation.epoch, me, rotation.keys);
          await client.query(
            "UPDATE chats SET key_epoch = $2, encrypted_info = $3, rotation_needed = FALSE WHERE id = $1",
            [chatId, rotation.epoch, rotation.encrypted_info],
          );
        } else {
          await client.query("UPDATE chats SET rotation_needed = TRUE WHERE id = $1", [chatId]);
        }

        messages.unshift(
          await addSystemMessage(
            client,
            chatId,
            me,
            leaving ? { type: "left" } : { type: "removed", users: removed ? [removed] : [] },
          ),
        );

        return { messages, deleted: false };
      });

      if (!done) {
        return;
      }

      // The removed member's devices drop the group.
      sendToUserSockets(userId, { type: "chat_deleted", chatId });

      if (!done.deleted) {
        await announce(chatId, done.messages);
      }

      return { removed: true };
    },
  );

  // ROLE of a member (the owner makes admins).
  server.put<{ Params: { chatId: string; userId: string }; Body: { role: "admin" | "member" } }>(
    "/api/chats/:chatId/members/:userId/role",
    {
      preHandler: authenticate,
      config: groupRateLimit,
      schema: {
        params: { type: "object", required: ["chatId", "userId"], properties: { chatId: UUID, userId: UUID } },
        body: {
          type: "object",
          required: ["role"],
          properties: { role: { type: "string", enum: ["admin", "member"] } },
        },
      },
    },
    async (request, reply) => {
      const { chatId, userId } = request.params;
      const { role } = request.body;
      const me = request.user.id;

      const done = await change(reply, async (client) => {
        const membership = await groupMembership(chatId, me, client);
        const target = await groupMembership(chatId, userId, client);

        if (!membership || membership.role !== "owner") {
          throw new Refused(403, "Only the group's owner can change roles");
        }

        if (!target || target.role === "owner") {
          throw new Refused(400, "This member's role cannot be changed");
        }

        await client.query("UPDATE chat_members SET role = $3 WHERE chat_id = $1 AND user_id = $2", [
          chatId,
          userId,
          role,
        ]);

        const [user] = await usernames(client, [userId]);

        return [await addSystemMessage(client, chatId, me, { type: "role", user, role: role as Role })];
      });

      if (!done) {
        return;
      }

      await announce(chatId, done);

      return { role };
    },
  );

  // INFO: the encrypted name and photo (admins). A photo is an encrypted
  // attachment the admin uploaded; it becomes the chat's.
  server.put<{ Params: { chatId: string }; Body: { encrypted_info: string; photo_id?: string | null } }>(
    "/api/chats/:chatId/info",
    {
      preHandler: authenticate,
      config: groupRateLimit,
      schema: {
        params: chatParams,
        body: {
          type: "object",
          required: ["encrypted_info"],
          properties: {
            encrypted_info: ENCRYPTED_INFO,
            photo_id: { anyOf: [UUID, { type: "null" }] },
          },
        },
      },
    },
    async (request, reply) => {
      const { chatId } = request.params;
      const { encrypted_info, photo_id: photoId } = request.body;
      const me = request.user.id;

      const done = await change(reply, async (client) => {
        const membership = await groupMembership(chatId, me, client);

        if (!membership || !isAdmin(membership.role)) {
          throw new Refused(403, "Only the group's admins can change it");
        }

        if (epochOf(encrypted_info) !== membership.key_epoch) {
          throw new Refused(409, "The group key has changed: load it and try again");
        }

        if (photoId !== undefined) {
          // The previous photo goes (its file with the next cleanup).
          await client.query("DELETE FROM attachments WHERE chat_id = $1 AND id IS DISTINCT FROM $2", [
            chatId,
            photoId,
          ]);

          if (photoId) {
            const linked = await client.query(
              `
              UPDATE attachments SET chat_id = $1
              WHERE id = $2 AND uploader_id = $3 AND message_id IS NULL
              `,
              [chatId, photoId, me],
            );

            if (linked.rowCount === 0) {
              throw new Refused(400, "Upload the photo first");
            }
          }
        }

        await client.query("UPDATE chats SET encrypted_info = $2 WHERE id = $1", [chatId, encrypted_info]);

        return [await addSystemMessage(client, chatId, me, { type: "info" })];
      });

      if (!done) {
        return;
      }

      await announce(chatId, done);

      return { saved: true };
    },
  );

  // NEW KEY for a group: the next epoch, wrapped for every member, and the
  // info encrypted with it. Admins may make one at any time; any member
  // when the group needs one (someone left).
  server.post<{ Params: { chatId: string }; Body: { epoch: number; keys: MemberKey[]; encrypted_info: string } }>(
    "/api/chats/:chatId/keys",
    {
      preHandler: authenticate,
      config: groupRateLimit,
      schema: {
        params: chatParams,
        body: {
          type: "object",
          required: ["epoch", "keys", "encrypted_info"],
          properties: { epoch: { type: "integer", minimum: 2 }, keys: memberKeys, encrypted_info: ENCRYPTED_INFO },
        },
      },
    },
    async (request, reply) => {
      const { chatId } = request.params;
      const { epoch, keys, encrypted_info } = request.body;
      const me = request.user.id;

      const done = await change(reply, async (client) => {
        await client.query("SELECT 1 FROM chats WHERE id = $1 FOR UPDATE", [chatId]);

        const membership = await groupMembership(chatId, me, client);

        if (!membership || !(isAdmin(membership.role) || membership.rotation_needed)) {
          throw new Refused(403, "Only admins can change the group key now");
        }

        if (epoch !== membership.key_epoch + 1 || epochOf(encrypted_info) !== epoch) {
          throw new Refused(409, "The group key has changed: load it and try again");
        }

        if (!coversExactly(keys, await memberIds(client, chatId))) {
          throw new Refused(400, "The new key must go to every member");
        }

        await storeKeys(client, chatId, epoch, me, keys);
        await client.query(
          "UPDATE chats SET key_epoch = $2, encrypted_info = $3, rotation_needed = FALSE WHERE id = $1",
          [chatId, epoch, encrypted_info],
        );

        return true;
      });

      if (!done) {
        return;
      }

      await sendToChatMembers(chatId, { type: "chats_changed" });

      return { epoch };
    },
  );
}
