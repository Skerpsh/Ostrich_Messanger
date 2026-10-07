import { FastifyRequest, FastifyReply } from "fastify";
import crypto from "node:crypto";
import { PROFILE_COLUMNS } from "../accounts.js";
import { db } from "../database.js";

export type AuthUser = FastifyRequest["user"];

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// Reads the token from "Authorization: Bearer <token>".
export function getBearerToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;

  if (!authorization) {
    return null;
  }

  const [type, token] = authorization.split(" ");

  if (type !== "Bearer" || !token) {
    return null;
  }

  return token;
}

export type Session = {
  user: AuthUser;
  tokenHash: string;
  expiresAt: Date;
};

export async function findSessionByHash(
  tokenHash: string,
): Promise<Session | null> {
  const result = await db.query(
    `
    SELECT
      users.id,
      users.username,
      users.created_at,
      users.username_changed_at,
      users.show_presence,
      users.read_receipts,
      ${PROFILE_COLUMNS},
      sessions.expires_at
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = $1
      AND sessions.expires_at > NOW()
    `,
    [tokenHash],
  );

  const row = result.rows[0];

  if (!row) {
    return null;
  }

  // For the list of devices; at most every few minutes per session.
  db.query(
    `
    UPDATE sessions
    SET last_used_at = NOW()
    WHERE token_hash = $1
      AND last_used_at < NOW() - INTERVAL '5 minutes'
    `,
    [tokenHash],
  ).catch(() => {});

  const { expires_at, ...user } = row;

  return { user, tokenHash, expiresAt: expires_at };
}

export async function findUserByToken(
  token: string,
): Promise<AuthUser | null> {
  return (await findSessionByHash(hashToken(token)))?.user ?? null;
}

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const token = getBearerToken(request);

  if (!token) {
    return reply.status(401).send({
      error: request.headers.authorization
        ? "Invalid authorization header"
        : "Authorization token is required",
    });
  }

  const user = await findUserByToken(token);

  if (!user) {
    return reply.status(401).send({
      error: "Invalid or expired token",
    });
  }

  request.user = user;
  request.token = token;
}
