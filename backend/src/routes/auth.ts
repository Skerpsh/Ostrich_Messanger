import { FastifyInstance } from "fastify";
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
  PROFILE_COLUMNS,
  formatOstrichId,
  generateOstrichId,
  hashOstrichId,
  OSTRICH_ID_INPUT_PATTERN,
  ostrichIdMatches,
  passwordSchema,
  usernameSchema,
  USERNAME_CHANGE_INTERVAL_DAYS,
} from "../accounts.js";
import { authenticate, hashToken } from "../middleware/auth.js";
import {
  closeSessionSockets,
  closeUserSockets,
  createTicket,
  sendToContacts,
} from "../realtime.js";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const registerSchema = {
  body: {
    type: "object",
    required: ["username", "password"],
    properties: {
      username: usernameSchema,
      password: passwordSchema,
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
      // Optional only for accounts created before OstrichIDs existed.
      ostrich_id: { type: "string", pattern: OSTRICH_ID_INPUT_PATTERN },
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
};

type LoginBody = {
  username: string;
  password: string;
  ostrich_id?: string;
};

const USER_COLUMNS = `id, username, created_at, username_changed_at, ${PROFILE_COLUMNS}`;

// Brute-force protection for endpoints that check passwords.
const authRateLimit = {
  rateLimit: {
    max: 10,
    timeWindow: "1 minute",
  },
};

// Rate limit for websocket tickets (one per connection attempt).
const ticketRateLimit = {
  rateLimit: {
    max: 30,
    timeWindow: "1 minute",
  },
};

// Per-account brute-force protection (the rate limit above is per IP):
// after MAX_FAILED_LOGINS wrong passwords the account's login is blocked
// until the window ends.
const MAX_FAILED_LOGINS = 10;
const FAILED_LOGIN_WINDOW_MS = 15 * 60 * 1000;

const failedLogins = new Map<string, { count: number; resetAt: number }>();

function loginBlocked(username: string): boolean {
  const entry = failedLogins.get(username.toLowerCase());

  if (!entry) {
    return false;
  }

  if (entry.resetAt <= Date.now()) {
    failedLogins.delete(username.toLowerCase());
    return false;
  }

  return entry.count >= MAX_FAILED_LOGINS;
}

function recordFailedLogin(username: string) {
  const key = username.toLowerCase();
  const now = Date.now();
  const entry = failedLogins.get(key);

  if (entry && entry.resetAt > now) {
    entry.count++;
    return;
  }

  // Drop stale entries so the map cannot grow without bound.
  if (failedLogins.size >= 10_000) {
    for (const [name, other] of failedLogins) {
      if (other.resetAt <= now) {
        failedLogins.delete(name);
      }
    }
  }

  failedLogins.set(key, { count: 1, resetAt: now + FAILED_LOGIN_WINDOW_MS });
}

// Used to spend the same time on unknown usernames as on wrong passwords,
// so login timing does not reveal which usernames exist.
const dummyPasswordHash = argon2.hash(crypto.randomBytes(16).toString("hex"));

export default async function authRoutes(server: FastifyInstance) {
  // REGISTER: creates the account and its OstrichID, which is returned
  // only in this response.
  server.post<{ Body: RegisterBody }>(
    "/api/auth/register",
    {
      schema: registerSchema,
      config: authRateLimit,
    },
    async (request, reply) => {
      const { username, password } = request.body;

      const passwordHash = await argon2.hash(password);
      const ostrichId = generateOstrichId();

      let user;

      try {
        const result = await db.query(
          `
          INSERT INTO users (
            username,
            password_hash,
            ostrich_id_hash
          )
          VALUES ($1, $2, $3)
          RETURNING ${USER_COLUMNS}
          `,
          [username, passwordHash, hashOstrichId(ostrichId)],
        );

        user = result.rows[0];
      } catch (error) {
        if (isPgError(error, PG_UNIQUE_VIOLATION)) {
          return reply.status(409).send({
            error: "Username is already taken",
          });
        }

        throw error;
      }

      const token = await createSession(user.id);

      return reply.status(201).send({
        message: "Registration successful",
        token,
        user: accountView(user),
        ostrich_id: formatOstrichId(ostrichId),
      });
    },
  );

  // LOGIN: username + password + OstrichID. Accounts created before
  // OstrichIDs log in without one once and get their ID in the response.
  server.post<{ Body: LoginBody }>(
    "/api/auth/login",
    {
      schema: loginSchema,
      config: authRateLimit,
    },
    async (request, reply) => {
      const { password, ostrich_id } = request.body;
      // "@alice" works too.
      const username = request.body.username.replace(/^@/, "");

      if (loginBlocked(username)) {
        return reply.status(429).send({
          error: "Too many failed login attempts, try again later",
        });
      }

      const result = await db.query(
        `
        SELECT ${USER_COLUMNS}, password_hash, ostrich_id_hash
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

      // Accounts without an OstrichID yet need none (it is issued below).
      const ostrichIdValid =
        user?.ostrich_id_hash == null ||
        ostrichIdMatches(ostrich_id ?? "", user.ostrich_id_hash);

      if (!user || !passwordValid || !ostrichIdValid) {
        recordFailedLogin(username);

        return reply.status(401).send({
          error: "Invalid username, password or OstrichID",
        });
      }

      let issuedOstrichId: string | null = null;

      if (user.ostrich_id_hash == null) {
        const ostrichId = generateOstrichId();

        // Only if no concurrent login has issued one in the meantime:
        // otherwise this client would show an ID that does not work.
        const updated = await db.query(
          `
          UPDATE users
          SET ostrich_id_hash = $2, updated_at = NOW()
          WHERE id = $1
            AND ostrich_id_hash IS NULL
          `,
          [user.id, hashOstrichId(ostrichId)],
        );

        if (updated.rowCount === 0) {
          return reply.status(401).send({
            error: "Invalid username, password or OstrichID",
          });
        }

        issuedOstrichId = formatOstrichId(ostrichId);
      }

      failedLogins.delete(username.toLowerCase());

      const token = await createSession(user.id);

      return reply.send({
        message: "Login successful",
        token,
        user: accountView(user),
        // Only when the account has just been given its OstrichID.
        ...(issuedOstrichId ? { ostrich_id: issuedOstrichId } : {}),
      });
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

      const current = await db.query(
        `
        SELECT password_hash
        FROM users
        WHERE id = $1
        `,
        [request.user.id],
      );

      if (!(await argon2.verify(current.rows[0].password_hash, password))) {
        return reply.status(403).send({
          error: "Password is incorrect",
        });
      }

      if (username === request.user.username) {
        return reply.status(400).send({
          error: "This is already your username",
        });
      }

      let result;

      try {
        result = await db.query(
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
      } catch (error) {
        if (isPgError(error, PG_UNIQUE_VIOLATION)) {
          return reply.status(409).send({
            error: "Username is already taken",
          });
        }

        throw error;
      }

      if (result.rowCount === 0) {
        const { next_username_change_at } = accountView(request.user);

        return reply.status(429).send({
          error: `The username can be changed once every ${USERNAME_CHANGE_INTERVAL_DAYS} days`,
          next_username_change_at,
        });
      }

      const user = accountView(result.rows[0]);

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

  // WEBSOCKET TICKET: single-use, short-lived credential for /ws?ticket=,
  // so browsers do not have to put the session token in the URL.
  server.post(
    "/api/auth/ws-ticket",
    {
      preHandler: authenticate,
      config: ticketRateLimit,
    },
    async (request) => {
      return {
        ticket: createTicket(hashToken(request.token)),
      };
    },
  );
}

async function createSession(userId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");

  await db.query(
    `
    INSERT INTO sessions (
      user_id,
      token_hash,
      expires_at
    )
    VALUES ($1, $2, $3)
    `,
    [userId, hashToken(token), new Date(Date.now() + SESSION_TTL_MS)],
  );

  return token;
}
