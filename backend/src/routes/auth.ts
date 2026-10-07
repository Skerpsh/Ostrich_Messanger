import { FastifyInstance } from "fastify";
import argon2 from "argon2";
import crypto from "node:crypto";
import { db, isPgError, PG_UNIQUE_VIOLATION } from "../database.js";
import { authenticate, hashToken } from "../middleware/auth.js";
import { closeSession } from "../realtime.js";

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
        return reply.status(401).send({
          error: "Invalid username or password",
        });
      }

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

      // Open websockets of this session must not keep receiving messages.
      closeSession(tokenHash);

      return {
        message: "Logout successful",
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
