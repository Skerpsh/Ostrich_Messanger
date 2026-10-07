import { FastifyInstance } from "fastify";
import { usernameSchema } from "../accounts.js";
import { db } from "../database.js";
import { authenticate } from "../middleware/auth.js";

// Exact lookups only (no search by part of a name), so the list of users
// cannot be enumerated; also rate limited per IP.
export const userLookupRateLimit = {
  rateLimit: {
    max: 30,
    timeWindow: "1 minute",
  },
};

export default async function usersRoutes(server: FastifyInstance) {
  // FIND a user by their exact @username (case-insensitive)
  server.get<{ Params: { username: string } }>(
    "/api/users/:username",
    {
      preHandler: authenticate,
      config: userLookupRateLimit,
      schema: {
        params: {
          type: "object",
          required: ["username"],
          properties: {
            username: usernameSchema,
          },
        },
      },
    },
    async (request, reply) => {
      const result = await db.query(
        `
        SELECT id, username
        FROM users
        WHERE LOWER(username) = LOWER($1)
        `,
        [request.params.username],
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({
          error: "User not found",
        });
      }

      return reply.send({
        user: result.rows[0],
      });
    },
  );
}
