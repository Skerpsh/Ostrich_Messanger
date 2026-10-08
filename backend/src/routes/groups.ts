import crypto from "node:crypto";
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

// Requests waiting at most per group.
const MAX_JOIN_REQUESTS = 100;

// The group's admins reload their chats list (its request count).
async function notifyAdmins(chatId: string) {
  const admins = await db.query(
    "SELECT user_id FROM chat_members WHERE chat_id = $1 AND role IN ('owner', 'admin')",
    [chatId],
  );

  for (const { user_id } of admins.rows) {
    sendToUserSockets(user_id, { type: "chats_changed" });
  }
}

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
        // Asked through the invite link: answered.
        await client.query("DELETE FROM group_join_requests WHERE chat_id = $1 AND user_id = $2", [chatId, userId]);

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

  // --- invite links ---
  // Whoever opens a group's link asks to join; an admin lets them in by
  // adding them (POST …/members, their app wraps the key). The token only
  // allows asking.

  const adminOnly = async (chatId: string, userId: string) => {
    const membership = await groupMembership(chatId, userId);
    return membership && isAdmin(membership.role) ? membership : null;
  };

  // The group's link (admins); null if there is none.
  server.get<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/invite",
    { preHandler: authenticate, schema: { params: chatParams } },
    async (request, reply) => {
      if (!(await adminOnly(request.params.chatId, request.user.id))) {
        return reply.status(403).send({ error: "Only the group's admins can see its link" });
      }

      const result = await db.query("SELECT token FROM group_invites WHERE chat_id = $1", [
        request.params.chatId,
      ]);

      return { token: result.rows[0]?.token ?? null };
    },
  );

  // A new link (the old one stops working).
  server.put<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/invite",
    { preHandler: authenticate, config: groupRateLimit, schema: { params: chatParams } },
    async (request, reply) => {
      const { chatId } = request.params;

      if (!(await adminOnly(chatId, request.user.id))) {
        return reply.status(403).send({ error: "Only the group's admins can make a link" });
      }

      const token = crypto.randomBytes(16).toString("base64url");

      await db.query(
        `
        INSERT INTO group_invites (chat_id, token, created_by) VALUES ($1, $2, $3)
        ON CONFLICT (chat_id) DO UPDATE
        SET token = EXCLUDED.token, created_by = EXCLUDED.created_by, created_at = NOW()
        `,
        [chatId, token, request.user.id],
      );

      return { token };
    },
  );

  server.delete<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/invite",
    { preHandler: authenticate, config: groupRateLimit, schema: { params: chatParams } },
    async (request, reply) => {
      if (!(await adminOnly(request.params.chatId, request.user.id))) {
        return reply.status(403).send({ error: "Only the group's admins can remove its link" });
      }

      await db.query("DELETE FROM group_invites WHERE chat_id = $1", [request.params.chatId]);

      return { removed: true };
    },
  );

  const tokenParams = {
    type: "object",
    required: ["token"],
    properties: { token: { type: "string", pattern: "^[A-Za-z0-9_-]{16,64}$" } },
  } as const;

  // What a link leads to: the group's size and who made the link (its
  // name is encrypted: members only), and where the user stands.
  server.get<{ Params: { token: string } }>(
    "/api/invites/:token",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: { params: tokenParams },
    },
    async (request, reply) => {
      const result = await db.query(
        `
        SELECT
          i.chat_id,
          creator.username AS invited_by,
          (SELECT COUNT(*)::int FROM chat_members cm WHERE cm.chat_id = i.chat_id) AS member_count,
          EXISTS (
            SELECT 1 FROM chat_members cm WHERE cm.chat_id = i.chat_id AND cm.user_id = $2
          ) AS member,
          EXISTS (
            SELECT 1 FROM group_join_requests r WHERE r.chat_id = i.chat_id AND r.user_id = $2
          ) AS requested
        FROM group_invites i
        LEFT JOIN users creator ON creator.id = i.created_by
        WHERE i.token = $1
        `,
        [request.params.token, request.user.id],
      );

      const invite = result.rows[0];

      if (!invite) {
        return reply.status(404).send({ error: "This invite link is not valid (any more)" });
      }

      return {
        invite: {
          chat_id: invite.member ? invite.chat_id : null,
          invited_by: invite.invited_by,
          member_count: invite.member_count,
          status: invite.member ? "member" : invite.requested ? "requested" : "none",
        },
      };
    },
  );

  // Asks to join; the group's admins see it.
  server.post<{ Params: { token: string } }>(
    "/api/invites/:token/request",
    {
      preHandler: authenticate,
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: { params: tokenParams },
    },
    async (request, reply) => {
      const me = request.user.id;

      const done = await change(reply, async (client) => {
        const invite = await client.query("SELECT chat_id FROM group_invites WHERE token = $1", [
          request.params.token,
        ]);
        const chatId = invite.rows[0]?.chat_id as string | undefined;

        if (!chatId) {
          throw new Refused(404, "This invite link is not valid (any more)");
        }

        const member = await client.query(
          "SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2",
          [chatId, me],
        );

        if (member.rows.length > 0) {
          throw new Refused(409, "You are already in this group");
        }

        const keys = await client.query("SELECT public_key FROM users WHERE id = $1", [me]);

        if (!keys.rows[0]?.public_key) {
          throw new Refused(400, "Set up end-to-end encryption first: open the updated Ostrich");
        }

        const pending = await client.query(
          "SELECT COUNT(*)::int AS n FROM group_join_requests WHERE chat_id = $1",
          [chatId],
        );

        if (pending.rows[0].n >= MAX_JOIN_REQUESTS) {
          throw new Refused(429, "This group has too many requests waiting; try later");
        }

        await client.query(
          "INSERT INTO group_join_requests (chat_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [chatId, me],
        );

        return chatId;
      });

      if (!done) {
        return;
      }

      await notifyAdmins(done);

      return reply.status(201).send({ requested: true });
    },
  );

  // Takes the user's request back.
  server.delete<{ Params: { token: string } }>(
    "/api/invites/:token/request",
    { preHandler: authenticate, config: groupRateLimit, schema: { params: tokenParams } },
    async (request) => {
      const result = await db.query(
        `
        DELETE FROM group_join_requests r
        USING group_invites i
        WHERE i.token = $1 AND r.chat_id = i.chat_id AND r.user_id = $2
        RETURNING r.chat_id
        `,
        [request.params.token, request.user.id],
      );

      if (result.rows[0]) {
        await notifyAdmins(result.rows[0].chat_id);
      }

      return { cancelled: true };
    },
  );

  // Who asks to join (admins), with their keys (to let them in).
  server.get<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/requests",
    { preHandler: authenticate, schema: { params: chatParams } },
    async (request, reply) => {
      if (!(await adminOnly(request.params.chatId, request.user.id))) {
        return reply.status(403).send({ error: "Only the group's admins see the requests" });
      }

      const result = await db.query(
        `
        SELECT users.id, users.username, users.public_key, ${PROFILE_COLUMNS}, r.created_at
        FROM group_join_requests r
        JOIN users ON users.id = r.user_id
        WHERE r.chat_id = $1
        ORDER BY r.created_at
        `,
        [request.params.chatId],
      );

      return { requests: result.rows };
    },
  );

  // Declines a request (admins).
  server.delete<{ Params: { chatId: string; userId: string } }>(
    "/api/chats/:chatId/requests/:userId",
    {
      preHandler: authenticate,
      config: groupRateLimit,
      schema: {
        params: { type: "object", required: ["chatId", "userId"], properties: { chatId: UUID, userId: UUID } },
      },
    },
    async (request, reply) => {
      const { chatId, userId } = request.params;

      if (!(await adminOnly(chatId, request.user.id))) {
        return reply.status(403).send({ error: "Only the group's admins can decline requests" });
      }

      await db.query("DELETE FROM group_join_requests WHERE chat_id = $1 AND user_id = $2", [chatId, userId]);
      await notifyAdmins(chatId);

      return { declined: true };
    },
  );
}
