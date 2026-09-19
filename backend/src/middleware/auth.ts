import { FastifyRequest, FastifyReply } from "fastify";
import crypto from "node:crypto";
import { db } from "../database.js";

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
) {
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

  request.user = result.rows[0];
}
