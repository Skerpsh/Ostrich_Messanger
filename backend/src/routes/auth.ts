import { FastifyInstance } from "fastify";
import argon2 from "argon2";
import crypto from "node:crypto";
import {
  db,
  isPgError,
  PG_UNIQUE_VIOLATION,
  withTransaction,
} from "../database.js";
import { authenticate, hashToken } from "../middleware/auth.js";
import {
  closeSessionSockets,
  closeUserSockets,
  createTicket,
} from "../realtime.js";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Letters, digits, "_", "." and "-" only: usernames are shown in terminals,
// so control characters and look-alike whitespace are not allowed.
const credentialsSchema = {
  body: {
    type: "object",
    required: ["username", "password"],
    properties: {
      username: {
        type: "string",
        minLength: 3,
        maxLength: 32,
        pattern: "^[A-Za-z0-9_.-]+$",
      },
      password: {
        type: "string",
        minLength: 8,
        maxLength: 128,
      },
    },
  },
} as const;

const changePasswordSchema = {
  body: {
    type: "object",
    required: ["current_password", "new_password"],
    properties: {
      current_password: { type: "string", maxLength: 128 },
      new_password: credentialsSchema.body.properties.password,
    },
  },
} as const;

type Credentials = {
  username: string;
  password: string;
};

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
  // REGISTER
  server.post<{ Body: Credentials }>(
    "/api/auth/register",
    {
      schema: credentialsSchema,
      config: authRateLimit,
    },
    async (request, reply) => {
      const { username, password } = request.body;

      const passwordHash = await argon2.hash(password);

      // login_id is random, retry on the (unlikely) collision.
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const result = await db.query(
            `
            INSERT INTO users (
              login_id,
              username,
              password_hash
            )
            VALUES ($1, $2, $3)
            RETURNING id, login_id, username, created_at
            `,
            [generateLoginId(), username, passwordHash],
          );

          const user = result.rows[0];
          const token = await createSession(user.id);

          return reply.status(201).send({
            message: "Registration successful",
            token,
            user,
          });
        } catch (error) {
          if (!isPgError(error, PG_UNIQUE_VIOLATION)) {
            throw error;
          }

          const constraint = (error as { constraint?: string }).constraint;

          if (constraint !== "users_login_id_key") {
            return reply.status(409).send({
              error: "Username already exists",
            });
          }
        }
      }

      throw new Error("Failed to generate a unique login_id");
    },
  );

  // LOGIN
  server.post<{ Body: Credentials }>(
    "/api/auth/login",
    {
      schema: credentialsSchema,
      config: authRateLimit,
    },
    async (request, reply) => {
      const { username, password } = request.body;

      if (loginBlocked(username)) {
        return reply.status(429).send({
          error: "Too many failed login attempts, try again later",
        });
      }

      const result = await db.query(
        `
        SELECT id, login_id, username, password_hash
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

      if (!user || !passwordValid) {
        recordFailedLogin(username);

        return reply.status(401).send({
          error: "Invalid username or password",
        });
      }

      failedLogins.delete(username.toLowerCase());

      const token = await createSession(user.id);

      return reply.send({
        message: "Login successful",
        token,
        user: {
          id: user.id,
          login_id: user.login_id,
          username: user.username,
        },
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
        user: request.user,
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

// 16-digit numeric ID that users share to start a chat.
function generateLoginId(): string {
  const first = crypto.randomInt(
    1_000_000,
    10_000_000,
  );

  const second = crypto.randomInt(
    100_000_000,
    1_000_000_000,
  );

  return `${first}${second}`;
}
