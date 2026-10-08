import { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import argon2 from "argon2";
import crypto from "node:crypto";
import {
  db,
  isPgError,
  PG_UNIQUE_VIOLATION,
  withTransaction,
} from "../database.js";
import {
  accountView,
  AUTH_KEY_PATTERN,
  authKeyMatches,
  hashAuthKey,
  keyMaterialSchema,
  OSTRICH_ID_INPUT_PATTERN,
  ostrichIdMatches,
  passwordSchema,
  PROFILE_COLUMNS,
  usernameSchema,
  USERNAME_CHANGE_INTERVAL_DAYS,
  type KeyMaterial,
} from "../accounts.js";
import {
  authenticate,
  hashToken,
  SESSION_TTL_DAYS,
} from "../middleware/auth.js";
import { leaveAllGroups } from "../groups.js";
import { sharedState } from "../shared-state.js";
import {
  closeSessionSockets,
  closeUserSockets,
  createTicket,
  sendToChatMembers,
  sendToContacts,
} from "../realtime.js";

// The client generates the OstrichID and sends only what it derives from
// it: the auth key and the account's (encrypted) keys.
const registerSchema = {
  body: {
    type: "object",
    required: ["username", "password", "keys"],
    properties: {
      username: usernameSchema,
      password: passwordSchema,
      keys: keyMaterialSchema,
    },
  },
} as const;

// Login accepts any password length: the rules for new passwords may have
// changed since an account was created.
const loginSchema = {
  body: {
    type: "object",
    required: ["username", "password"],
    properties: {
      username: { type: "string", maxLength: 64 },
      password: { type: "string", maxLength: 128 },
      // Derived from the OstrichID on the client.
      auth_key: { type: "string", pattern: AUTH_KEY_PATTERN },
      // Accounts from before end-to-end encryption (the server answered
      // 409 "upgrade_required"): the raw OstrichID once, with the keys
      // derived from it.
      ostrich_id: { type: "string", pattern: OSTRICH_ID_INPUT_PATTERN },
      keys: keyMaterialSchema,
    },
  },
} as const;

const upgradeKeysSchema = {
  body: {
    type: "object",
    required: ["ostrich_id", "keys"],
    properties: {
      ostrich_id: { type: "string", pattern: OSTRICH_ID_INPUT_PATTERN },
      keys: keyMaterialSchema,
    },
  },
} as const;

const changePasswordSchema = {
  body: {
    type: "object",
    required: ["current_password", "new_password"],
    properties: {
      current_password: { type: "string", maxLength: 128 },
      new_password: passwordSchema,
    },
  },
} as const;

const changeUsernameSchema = {
  body: {
    type: "object",
    required: ["username", "password"],
    properties: {
      username: usernameSchema,
      password: { type: "string", maxLength: 128 },
    },
  },
} as const;

type RegisterBody = {
  username: string;
  password: string;
  keys: KeyMaterial;
};

type LoginBody = {
  username: string;
  password: string;
  auth_key?: string;
  ostrich_id?: string;
  keys?: KeyMaterial;
};

// The app a request comes from, for the list of devices.
function clientName(request: FastifyRequest): string {
  const value = request.headers["x-ostrich-client"];

  return typeof value === "string" && /^[a-z]{2,16}$/.test(value)
    ? value
    : "unknown";
}

// The account's keys as sent to its owner after logging in.
function keysView(row: { public_key: string; encrypted_private_key: string }) {
  return {
    public_key: row.public_key,
    encrypted_private_key: row.encrypted_private_key,
  };
}

const USER_COLUMNS = `id, username, created_at, username_changed_at, show_presence, read_receipts, ${PROFILE_COLUMNS}`;

// Brute-force protection for endpoints that check passwords.
const authRateLimit = {
  rateLimit: {
    max: 10,
    timeWindow: "1 minute",
  },
};

// Cheap requests that are still worth bounding: websocket tickets (one per
// connection attempt), privacy settings.
const frequentRateLimit = {
  rateLimit: {
    max: 30,
    timeWindow: "1 minute",
  },
};

// Brute-force protection per account and address: after MAX_FAILED_LOGINS
// wrong passwords (or OstrichIDs) from one IP, that IP cannot try the
// account again until the window ends. Counting per account only would
// let anyone lock any user out, since usernames are public. Guessing from
// many addresses gains little: a login needs the password and the
// OstrichID (~99 random bits), and the response does not say which one
// was wrong.
const MAX_FAILED_LOGINS = 10;
const FAILED_LOGIN_WINDOW_MS = 15 * 60 * 1000;

// Counted in the shared state (shared-state.ts), so it holds across
// processes.
function failedLoginKey(request: FastifyRequest, username: string) {
  return `${username.toLowerCase()} ${request.ip}`;
}

async function loginBlocked(request: FastifyRequest, username: string) {
  return (await sharedState().failures(failedLoginKey(request, username))) >= MAX_FAILED_LOGINS;
}

function recordFailedLogin(request: FastifyRequest, username: string) {
  return sharedState().addFailure(failedLoginKey(request, username), FAILED_LOGIN_WINDOW_MS);
}

function clearFailedLogins(request: FastifyRequest, username: string) {
  return sharedState().clearFailures(failedLoginKey(request, username));
}

const TOO_MANY_ATTEMPTS = "Too many failed attempts, try again later";

// Used to spend the same time on unknown usernames as on wrong passwords,
// so login timing does not reveal which usernames exist.
const dummyPasswordHash = argon2.hash(crypto.randomBytes(16).toString("hex"));

export default async function authRoutes(server: FastifyInstance) {
  // REGISTER: the OstrichID was generated on the client; only the auth key
  // and the account keys derived from it arrive here.
  server.post<{ Body: RegisterBody }>(
    "/api/auth/register",
    {
      schema: registerSchema,
      config: authRateLimit,
    },
    async (request, reply) => {
      const { username, password, keys } = request.body;

      const passwordHash = await argon2.hash(password);

      let user;

      try {
        user = await withTransaction(async (client) => {
          if (!(await claimUsername(client, username, null))) {
            return null;
          }

          const result = await client.query(
            `
            INSERT INTO users (
              username,
              password_hash,
              auth_key_hash,
              public_key,
              encrypted_private_key
            )
            VALUES ($1, $2, $3, $4, $5)
            RETURNING ${USER_COLUMNS}
            `,
            [
              username,
              passwordHash,
              hashAuthKey(keys.auth_key),
              keys.public_key,
              keys.encrypted_private_key,
            ],
          );

          return result.rows[0];
        });
      } catch (error) {
        // Taken by someone else meanwhile.
        if (!isPgError(error, PG_UNIQUE_VIOLATION)) {
          throw error;
        }
      }

      if (!user) {
        return reply.status(409).send({
          error: USERNAME_TAKEN,
        });
      }

      const token = await createSession(user.id, clientName(request));

      return reply.status(201).send({
        message: "Registration successful",
        token,
        user: accountView(user),
      });
    },
  );

  // LOGIN: username + password + the auth key derived from the OstrichID.
  // Answers with the account's encrypted keys.
  server.post<{ Body: LoginBody }>(
    "/api/auth/login",
    {
      schema: loginSchema,
      config: authRateLimit,
    },
    async (request, reply) => {
      const { password, auth_key, ostrich_id, keys } = request.body;
      // "@alice" works too.
      const username = request.body.username.replace(/^@/, "");

      if (await loginBlocked(request, username)) {
        return reply.status(429).send({ error: TOO_MANY_ATTEMPTS });
      }

      const result = await db.query(
        `
        SELECT ${USER_COLUMNS}, password_hash, ostrich_id_hash, auth_key_hash,
               public_key, encrypted_private_key
        FROM users
        WHERE LOWER(username) = LOWER($1)
        `,
        [username],
      );

      const user = result.rows[0];

      const passwordValid = await argon2.verify(
        user ? user.password_hash : await dummyPasswordHash,
        password,
      );

      const fail = async () => {
        await recordFailedLogin(request, username);

        return reply.status(401).send({
          error: "Invalid username, password or OstrichID",
        });
      };

      if (!user || !passwordValid) {
        return fail();
      }

      let accountKeys;

      if (user.auth_key_hash) {
        if (!authKeyMatches(auth_key, user.auth_key_hash)) {
          return fail();
        }

        accountKeys = keysView(user);
      } else if (user.ostrich_id_hash) {
        // Created before end-to-end encryption: the client sends the raw
        // OstrichID once, with the keys it derived from it.
        if (!ostrich_id || !keys) {
          return reply.status(409).send({
            error: "This account needs its OstrichID once to set up encryption",
            code: "upgrade_required",
          });
        }

        if (!ostrichIdMatches(ostrich_id, user.ostrich_id_hash)) {
          return fail();
        }

        accountKeys = keysView(await setAccountKeys(user.id, keys));
      } else {
        return fail();
      }

      await clearFailedLogins(request, username);

      const token = await createSession(user.id, clientName(request));

      return reply.send({
        message: "Login successful",
        token,
        user: accountView(user),
        keys: accountKeys,
      });
    },
  );

  // KEYS: the account's encrypted keys, for a device that is logged in but
  // does not have them (e.g. after updating the app). "upgrade_required"
  // for accounts from before end-to-end encryption.
  server.get(
    "/api/auth/keys",
    {
      preHandler: authenticate,
    },
    async (request, reply) => {
      const result = await db.query(
        `
        SELECT public_key, encrypted_private_key
        FROM users
        WHERE id = $1
        `,
        [request.user.id],
      );

      const row = result.rows[0];

      if (!row.public_key) {
        return reply.status(409).send({
          error: "This account needs its OstrichID once to set up encryption",
          code: "upgrade_required",
        });
      }

      return { keys: keysView(row) };
    },
  );

  // UPGRADE KEYS: sets up encryption for an account from before it, from a
  // logged-in device. The raw OstrichID proves the user knows it.
  server.post<{ Body: { ostrich_id: string; keys: KeyMaterial } }>(
    "/api/auth/keys/upgrade",
    {
      preHandler: authenticate,
      schema: upgradeKeysSchema,
      config: authRateLimit,
    },
    async (request, reply) => {
      const { ostrich_id, keys } = request.body;

      if (await loginBlocked(request, request.user.username)) {
        return reply.status(429).send({ error: TOO_MANY_ATTEMPTS });
      }

      const result = await db.query(
        `
        SELECT ostrich_id_hash, public_key
        FROM users
        WHERE id = $1
        `,
        [request.user.id],
      );

      const row = result.rows[0];

      if (row.public_key) {
        return reply.status(409).send({
          error: "Encryption is already set up for this account",
          code: "already_set_up",
        });
      }

      if (
        !row.ostrich_id_hash ||
        !ostrichIdMatches(ostrich_id, row.ostrich_id_hash)
      ) {
        await recordFailedLogin(request, request.user.username);

        // Not 401: the session is fine, clients would log out on a 401.
        return reply.status(403).send({
          error: "Wrong OstrichID",
        });
      }

      return { keys: keysView(await setAccountKeys(request.user.id, keys)) };
    },
  );

  // ME
  server.get(
    "/api/auth/me",
    {
      preHandler: authenticate,
    },
    async (request) => {
      return {
        user: accountView(request.user),
      };
    },
  );

  // LOGOUT
  server.post(
    "/api/auth/logout",
    {
      preHandler: authenticate,
    },
    async (request) => {
      const tokenHash = hashToken(request.token);

      await db.query(
        `
        DELETE FROM sessions
        WHERE token_hash = $1
        `,
        [tokenHash],
      );

      closeSessionSockets(tokenHash);

      return {
        message: "Logout successful",
      };
    },
  );

  // LOGOUT ALL (every session of the user, including this one)
  server.post(
    "/api/auth/logout-all",
    {
      preHandler: authenticate,
    },
    async (request) => {
      await db.query(
        `
        DELETE FROM sessions
        WHERE user_id = $1
        `,
        [request.user.id],
      );

      closeUserSockets(request.user.id);

      return {
        message: "Logged out of all sessions",
      };
    },
  );

  // CHANGE PASSWORD (ends all other sessions)
  server.post<{ Body: { current_password: string; new_password: string } }>(
    "/api/auth/password",
    {
      preHandler: authenticate,
      schema: changePasswordSchema,
      config: authRateLimit,
    },
    async (request, reply) => {
      const { current_password, new_password } = request.body;

      if (await loginBlocked(request, request.user.username)) {
        return reply.status(429).send({ error: TOO_MANY_ATTEMPTS });
      }

      const result = await db.query(
        `
        SELECT password_hash
        FROM users
        WHERE id = $1
        `,
        [request.user.id],
      );

      const passwordValid = await argon2.verify(
        result.rows[0].password_hash,
        current_password,
      );

      if (!passwordValid) {
        await recordFailedLogin(request, request.user.username);

        return reply.status(403).send({
          error: "Current password is incorrect",
        });
      }

      const tokenHash = hashToken(request.token);
      const passwordHash = await argon2.hash(new_password);

      await withTransaction(async (client) => {
        await client.query(
          `
          UPDATE users
          SET password_hash = $2, updated_at = NOW()
          WHERE id = $1
          `,
          [request.user.id, passwordHash],
        );

        await client.query(
          `
          DELETE FROM sessions
          WHERE user_id = $1
            AND token_hash <> $2
          `,
          [request.user.id, tokenHash],
        );
      });

      closeUserSockets(request.user.id, tokenHash);

      return {
        message: "Password changed",
      };
    },
  );

  // CHANGE USERNAME: allowed right after registration, then once per
  // USERNAME_CHANGE_INTERVAL_DAYS. Needs the password: the username is a
  // login credential, so a stolen session must not be enough to change it.
  server.post<{ Body: { username: string; password: string } }>(
    "/api/auth/username",
    {
      preHandler: authenticate,
      schema: changeUsernameSchema,
      config: authRateLimit,
    },
    async (request, reply) => {
      const { username, password } = request.body;

      if (await loginBlocked(request, request.user.username)) {
        return reply.status(429).send({ error: TOO_MANY_ATTEMPTS });
      }

      const current = await db.query(
        `
        SELECT password_hash
        FROM users
        WHERE id = $1
        `,
        [request.user.id],
      );

      if (!(await argon2.verify(current.rows[0].password_hash, password))) {
        await recordFailedLogin(request, request.user.username);

        return reply.status(403).send({
          error: "Password is incorrect",
        });
      }

      if (username === request.user.username) {
        return reply.status(400).send({
          error: "This is already your username",
        });
      }

      const tooSoon = () =>
        reply.status(429).send({
          error: `The username can be changed once every ${USERNAME_CHANGE_INTERVAL_DAYS} days`,
          next_username_change_at:
            accountView(request.user).next_username_change_at,
        });

      if (accountView(request.user).next_username_change_at) {
        return tooSoon();
      }

      let result;

      try {
        result = await withTransaction(async (client) => {
          if (!(await claimUsername(client, username, request.user.id))) {
            return "taken" as const;
          }

          const updated = await client.query(
            `
            UPDATE users
            SET username = $2,
                username_changed_at = NOW(),
                updated_at = NOW()
            WHERE id = $1
              AND (
                username_changed_at IS NULL
                OR username_changed_at
                  <= NOW() - make_interval(days => $3)
              )
            RETURNING ${USER_COLUMNS}
            `,
            [request.user.id, username, USERNAME_CHANGE_INTERVAL_DAYS],
          );

          if (updated.rowCount === 0) {
            // Changed meanwhile from another device: undo the claim.
            throw new UsernameChangedMeanwhile();
          }

          // The old name stays the user's for a while (unless they only
          // changed its case), so nobody can take it over right away.
          if (username.toLowerCase() !== request.user.username.toLowerCase()) {
            await client.query(
              `
              INSERT INTO username_reservations (username_lower, user_id, reserved_until)
              VALUES (LOWER($1), $2, NOW() + make_interval(days => $3))
              ON CONFLICT (username_lower) DO UPDATE
              SET user_id = EXCLUDED.user_id,
                  reserved_until = EXCLUDED.reserved_until
              `,
              [request.user.username, request.user.id, USERNAME_RESERVATION_DAYS],
            );
          }

          return updated.rows[0];
        });
      } catch (error) {
        if (error instanceof UsernameChangedMeanwhile) {
          return tooSoon();
        }

        if (!isPgError(error, PG_UNIQUE_VIOLATION)) {
          throw error;
        }

        result = "taken" as const;
      }

      if (result === "taken") {
        return reply.status(409).send({
          error: USERNAME_TAKEN,
        });
      }

      await clearFailedLogins(request, request.user.username);

      const user = accountView(result);

      // Chats lists of the user's contacts and other devices show the new
      // name right away.
      await sendToContacts(user.id, {
        type: "profile",
        userId: user.id,
        username: user.username,
        avatarId: user.avatar_id,
        isDeveloper: user.is_developer,
      });

      return {
        message: "Username changed",
        user,
      };
    },
  );

  // PRIVACY: whether others see the user online / last seen, and whether
  // read receipts are exchanged.
  server.put<{ Body: { show_presence?: boolean; read_receipts?: boolean } }>(
    "/api/auth/privacy",
    {
      preHandler: authenticate,
      config: frequentRateLimit,
      schema: {
        body: {
          type: "object",
          properties: {
            show_presence: { type: "boolean" },
            read_receipts: { type: "boolean" },
          },
        },
      },
    },
    async (request) => {
      const { show_presence, read_receipts } = request.body;

      const result = await db.query(
        `
        UPDATE users
        SET show_presence = COALESCE($2::boolean, show_presence),
            read_receipts = COALESCE($3::boolean, read_receipts),
            updated_at = NOW()
        WHERE id = $1
        RETURNING ${USER_COLUMNS}
        `,
        [request.user.id, show_presence ?? null, read_receipts ?? null],
      );

      // Contacts reload their chats list (presence, read receipts).
      await sendToContacts(request.user.id, { type: "chats_changed" });

      return { user: accountView(result.rows[0]) };
    },
  );

  // SESSIONS: the devices the user is logged in on.
  server.get(
    "/api/auth/sessions",
    {
      preHandler: authenticate,
    },
    async (request) => {
      const result = await db.query(
        `
        SELECT id, client, created_at, last_used_at,
               token_hash = $2 AS current
        FROM sessions
        WHERE user_id = $1
          AND expires_at > NOW()
        ORDER BY current DESC, last_used_at DESC
        `,
        [request.user.id, hashToken(request.token)],
      );

      return { sessions: result.rows };
    },
  );

  // END SESSION: logs one device out.
  server.delete<{ Params: { sessionId: string } }>(
    "/api/auth/sessions/:sessionId",
    {
      preHandler: authenticate,
      schema: {
        params: {
          type: "object",
          required: ["sessionId"],
          properties: { sessionId: { type: "string", format: "uuid" } },
        },
      },
    },
    async (request, reply) => {
      const result = await db.query(
        `
        DELETE FROM sessions
        WHERE id = $1
          AND user_id = $2
        RETURNING token_hash
        `,
        [request.params.sessionId, request.user.id],
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: "Session not found" });
      }

      closeSessionSockets(result.rows[0].token_hash);

      return { deleted: true };
    },
  );

  // DELETE ACCOUNT: needs the password and the OstrichID (its auth key).
  // Removes the user's chats for both members, then the user.
  server.post<{ Body: { password: string; auth_key: string } }>(
    "/api/auth/delete-account",
    {
      preHandler: authenticate,
      config: authRateLimit,
      schema: {
        body: {
          type: "object",
          required: ["password", "auth_key"],
          properties: {
            password: { type: "string", maxLength: 128 },
            auth_key: { type: "string", pattern: AUTH_KEY_PATTERN },
          },
        },
      },
    },
    async (request, reply) => {
      const { password, auth_key } = request.body;

      if (await loginBlocked(request, request.user.username)) {
        return reply.status(429).send({ error: TOO_MANY_ATTEMPTS });
      }

      const result = await db.query(
        "SELECT password_hash, auth_key_hash FROM users WHERE id = $1",
        [request.user.id],
      );

      const row = result.rows[0];
      const passwordValid = await argon2.verify(row.password_hash, password);

      if (!passwordValid || !row.auth_key_hash || !authKeyMatches(auth_key, row.auth_key_hash)) {
        await recordFailedLogin(request, request.user.username);

        return reply.status(403).send({
          error: "Wrong password or OstrichID",
        });
      }

      const chats = await db.query(
        `
        SELECT chat_id FROM chat_members
        JOIN chats ON chats.id = chat_members.chat_id AND chats.type = 'direct'
        WHERE user_id = $1
        `,
        [request.user.id],
      );

      // Tell the other members while the direct chats still exist.
      for (const { chat_id } of chats.rows) {
        await sendToChatMembers(chat_id, { type: "chat_deleted", chatId: chat_id });
      }

      // Direct chats go for both; groups stay for the others.
      const groups = await withTransaction(async (client) => {
        const remaining = await leaveAllGroups(client, request.user.id);

        await client.query(
          `
          DELETE FROM chats
          WHERE type = 'direct'
            AND id IN (SELECT chat_id FROM chat_members WHERE user_id = $1)
          `,
          [request.user.id],
        );
        await client.query("DELETE FROM users WHERE id = $1", [request.user.id]);

        return remaining;
      });

      for (const chatId of groups) {
        await sendToChatMembers(chatId, { type: "chats_changed" });
      }

      closeUserSockets(request.user.id);

      return { deleted: true };
    },
  );

  // WEBSOCKET TICKET: single-use, short-lived credential for /ws?ticket=,
  // so browsers do not have to put the session token in the URL.
  server.post(
    "/api/auth/ws-ticket",
    {
      preHandler: authenticate,
      config: frequentRateLimit,
    },
    async (request) => {
      return {
        ticket: await createTicket(hashToken(request.token)),
      };
    },
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

const USERNAME_TAKEN = "Username is already taken";

class UsernameChangedMeanwhile extends Error {}

// How long a username given up by a change stays reserved for its former
// owner.
const USERNAME_RESERVATION_DAYS = USERNAME_CHANGE_INTERVAL_DAYS;

// Checks, inside a transaction, that `username` is not reserved for
// another user (see username_reservations) and locks it until the
// transaction ends, so a concurrent registration cannot slip in. The
// unique index on users still catches names in use. `userId` is the user
// taking the name (null when registering); their own reservation is
// released.
async function claimUsername(
  client: PoolClient,
  username: string,
  userId: string | null,
): Promise<boolean> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext(LOWER($1)))", [
    username,
  ]);

  const reserved = await client.query(
    `
    SELECT user_id
    FROM username_reservations
    WHERE username_lower = LOWER($1)
      AND reserved_until > NOW()
    `,
    [username],
  );

  const owner = reserved.rows[0]?.user_id as string | undefined;

  if (owner && owner !== userId) {
    return false;
  }

  if (owner) {
    await client.query(
      "DELETE FROM username_reservations WHERE username_lower = LOWER($1)",
      [username],
    );
  }

  return true;
}

async function createSession(userId: string, client: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");

  await db.query(
    `
    INSERT INTO sessions (
      user_id,
      token_hash,
      expires_at,
      client
    )
    VALUES ($1, $2, $3, $4)
    `,
    [userId, hashToken(token), new Date(Date.now() + SESSION_TTL_DAYS * DAY_MS), client],
  );

  return token;
}

// Replaces the server-side OstrichID hash with the client-derived auth key
// and stores the account keys. Only once: if a concurrent upgrade got there
// first, its keys are kept and returned.
async function setAccountKeys(
  userId: string,
  keys: KeyMaterial,
): Promise<{ public_key: string; encrypted_private_key: string }> {
  await db.query(
    `
    UPDATE users
    SET auth_key_hash = $2,
        public_key = $3,
        encrypted_private_key = $4,
        ostrich_id_hash = NULL,
        updated_at = NOW()
    WHERE id = $1
      AND public_key IS NULL
    `,
    [userId, hashAuthKey(keys.auth_key), keys.public_key, keys.encrypted_private_key],
  );

  const result = await db.query(
    "SELECT public_key, encrypted_private_key FROM users WHERE id = $1",
    [userId],
  );

  return result.rows[0];
}
