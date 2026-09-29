import { FastifyInstance } from "fastify";
import { db } from "../database.js";
import { authenticate } from "../middleware/auth.js";

export default async function usersRoutes(server: FastifyInstance) {
  server.get<{ Params: { loginId: string } }>(
    "/api/users/:loginId",
    {
      preHandler: authenticate,
      schema: {
        params: {
          type: "object",
          required: ["loginId"],
          properties: {
            loginId: { type: "string", pattern: "^[0-9]{1,18}$" },
          },
        },
      },
    },
    async (request, reply) => {
      const { loginId } = request.params;

      const result = await db.query(
        `
        SELECT
          id,
          login_id,
          username,
          created_at
        FROM users
        WHERE login_id = $1
        `,
        [loginId],
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
