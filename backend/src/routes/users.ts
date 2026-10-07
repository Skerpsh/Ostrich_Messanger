import { FastifyInstance } from "fastify";
import { db } from "../database.js";
import { authenticate } from "../middleware/auth.js";
import { sendToUserSockets } from "../realtime.js";

const blockRateLimit = {
  rateLimit: {
    max: 30,
    timeWindow: "1 minute",
  },
};

export default async function usersRoutes(server: FastifyInstance) {
  // BLOCK / UNBLOCK a user. Blocked users cannot message you or start a
  // chat with you, and neither of you sees the other's online status.
  const setBlocked = async (blockerId: string, blockedId: string, blocked: boolean) => {
    if (blocked) {
      await db.query(
        `
        INSERT INTO blocks (blocker_id, blocked_id)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
        `,
        [blockerId, blockedId],
      );
    } else {
      await db.query(
        "DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2",
        [blockerId, blockedId],
      );
    }

    // Both reload their chats list (blocked state, presence).
    sendToUserSockets(blockerId, { type: "chats_changed" });
    sendToUserSockets(blockedId, { type: "chats_changed" });
  };

  const userParamsSchema = {
    type: "object",
    required: ["userId"],
    properties: { userId: { type: "string", format: "uuid" } },
  } as const;

  server.put<{ Params: { userId: string } }>(
    "/api/users/:userId/block",
    {
      preHandler: authenticate,
      config: blockRateLimit,
      schema: { params: userParamsSchema },
    },
    async (request, reply) => {
      const { userId } = request.params;

      if (userId === request.user.id) {
        return reply.status(400).send({ error: "You cannot block yourself" });
      }

      const exists = await db.query("SELECT 1 FROM users WHERE id = $1", [userId]);

      if (exists.rows.length === 0) {
        return reply.status(404).send({ error: "User not found" });
      }

      await setBlocked(request.user.id, userId, true);

      return { blocked: true };
    },
  );

  server.delete<{ Params: { userId: string } }>(
    "/api/users/:userId/block",
    {
      preHandler: authenticate,
      config: blockRateLimit,
      schema: { params: userParamsSchema },
    },
    async (request) => {
      await setBlocked(request.user.id, request.params.userId, false);

      return { blocked: false };
    },
  );
}
