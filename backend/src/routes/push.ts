import { FastifyInstance } from "fastify";
import { db } from "../database.js";
import { authenticate, hashToken } from "../middleware/auth.js";
import { PUSH_TOKEN_PATTERN, setPushLogger } from "../push.js";

const pushRateLimit = {
  rateLimit: {
    max: 20,
    timeWindow: "1 minute",
  },
};

export default async function pushRoutes(server: FastifyInstance) {
  setPushLogger(server.log);

  // SET the push token of this session's device (the mobile apps).
  server.put<{ Body: { token: string } }>(
    "/api/push/token",
    {
      preHandler: authenticate,
      config: pushRateLimit,
      schema: {
        body: {
          type: "object",
          required: ["token"],
          properties: {
            token: { type: "string", pattern: PUSH_TOKEN_PATTERN },
          },
        },
      },
    },
    async (request) => {
      await db.query(
        `
        INSERT INTO push_tokens (session_id, token)
        SELECT id, $2 FROM sessions WHERE token_hash = $1
        ON CONFLICT (session_id) DO UPDATE SET token = EXCLUDED.token
        `,
        [hashToken(request.token), request.body.token],
      );

      return { saved: true };
    },
  );

  // REMOVE it (notifications turned off on the device).
  server.delete(
    "/api/push/token",
    {
      preHandler: authenticate,
      config: pushRateLimit,
    },
    async (request) => {
      await db.query(
        `
        DELETE FROM push_tokens
        WHERE session_id = (SELECT id FROM sessions WHERE token_hash = $1)
        `,
        [hashToken(request.token)],
      );

      return { removed: true };
    },
  );
}
