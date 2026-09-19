import { FastifyInstance } from "fastify";
import argon2 from "argon2";
import crypto from "node:crypto";
import { db } from "../database.js";

export default async function authRoutes(server: FastifyInstance) {
  // REGISTER
  server.post("/api/auth/register", async (request, reply) => {
    const body = request.body as {
      username?: string;
      password?: string;
    };

    const { username, password } = body;

    if (!username || !password) {
      return reply.status(400).send({
        error: "Username and password are required",
      });
    }

    if (username.length < 3 || username.length > 32) {
      return reply.status(400).send({
        error: "Username must be between 3 and 32 characters",
      });
    }

    if (password.length < 8) {
      return reply.status(400).send({
        error: "Password must be at least 8 characters",
      });
    }

    const existingUser = await db.query(
      "SELECT id FROM users WHERE username = $1",
      [username],
    );

    if (existingUser.rows.length > 0) {
      return reply.status(409).send({
        error: "Username already exists",
      });
    }

    const passwordHash = await argon2.hash(password);
    const loginId = generateLoginId();

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
      [loginId, username, passwordHash],
    );

    return reply.status(201).send({
      user: result.rows[0],
    });
  });

  // LOGIN
  server.post("/api/auth/login", async (request, reply) => {
    const body = request.body as {
      username?: string;
      password?: string;
    };

    const { username, password } = body;

    if (!username || !password) {
      return reply.status(400).send({
        error: "Username and password are required",
      });
    }

    const result = await db.query(
      `
      SELECT id, login_id, username, password_hash
      FROM users
      WHERE username = $1
      `,
      [username],
    );

    if (result.rows.length === 0) {
      return reply.status(401).send({
        error: "Invalid username or password",
      });
    }

    const user = result.rows[0];

    const passwordValid = await argon2.verify(
      user.password_hash,
      password,
    );

    if (!passwordValid) {
      return reply.status(401).send({
        error: "Invalid username or password",
      });
    }

    const token = crypto.randomBytes(32).toString("hex");

    const tokenHash = crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");

    const expiresAt = new Date(
      Date.now() + 30 * 24 * 60 * 60 * 1000,
    );

    await db.query(
      `
      INSERT INTO sessions (
        user_id,
        token_hash,
        expires_at
      )
      VALUES ($1, $2, $3)
      `,
      [user.id, tokenHash, expiresAt],
    );

    return reply.send({
      message: "Login successful",
      token,
      user: {
        id: user.id,
        login_id: user.login_id,
        username: user.username,
      },
    });
  });

  // ME
  server.get("/api/auth/me", async (request, reply) => {
    const authorization = request.headers.authorization;

    if (!authorization) {
      return reply.status(401).send({
        error: "Authorization token is required",
      });
    }

    const [type, token] = authorization.split(" ");

    if (type !== "Bearer" || !token) {
      return reply.status(401).send({
        error: "Invalid authorization header",
      });
    }

    const tokenHash = crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");

    const result = await db.query(
      `
      SELECT
        users.id,
        users.login_id,
        users.username,
        users.created_at
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = $1
        AND sessions.expires_at > NOW()
      `,
      [tokenHash],
    );

    if (result.rows.length === 0) {
      return reply.status(401).send({
        error: "Invalid or expired token",
      });
    }

    return reply.send({
      user: result.rows[0],
    });
  });

  // LOGOUT
  server.post("/api/auth/logout", async (request, reply) => {
    const authorization = request.headers.authorization;

    if (!authorization) {
      return reply.status(401).send({
        error: "Authorization token is required",
      });
    }

    const [type, token] = authorization.split(" ");

    if (type !== "Bearer" || !token) {
      return reply.status(401).send({
        error: "Invalid authorization header",
      });
    }

    const tokenHash = crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");

    await db.query(
      `
      DELETE FROM sessions
      WHERE token_hash = $1
      `,
      [tokenHash],
    );

    return reply.send({
      message: "Logout successful",
    });
  });
}

function generateLoginId(): string {
  const first = crypto.randomInt(
    1_000_000,
    9_999_999,
  );

  const second = crypto.randomInt(
    100_000_000,
    999_999_999,
  );

  return `${first}${second}`;
}
