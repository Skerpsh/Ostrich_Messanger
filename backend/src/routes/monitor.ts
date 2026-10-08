import { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { db } from "../database.js";
import { getBearerToken } from "../middleware/auth.js";
import { sharedState } from "../shared-state.js";

// For the monitoring bot (src/monitor/) on the same server: who is online
// is known only to the backend processes (in memory, or in Redis). Needs
// MONITOR_SECRET in .env, which the bot reads too; without it the route
// does not exist.
const MONITOR_SECRET = process.env.MONITOR_SECRET || undefined;

function sameSecret(given: string, expected: string) {
  const hash = (value: string) => crypto.createHash("sha256").update(value).digest();
  return crypto.timingSafeEqual(hash(given), hash(expected));
}

export default async function monitorRoutes(server: FastifyInstance) {
  if (!MONITOR_SECRET) {
    return;
  }

  server.get(
    "/api/internal/stats",
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      const token = getBearerToken(request);

      // Only straight from this machine: a request through the reverse
      // proxy carries X-Forwarded-For.
      if (request.headers["x-forwarded-for"] !== undefined || !token || !sameSecret(token, MONITOR_SECRET)) {
        return reply.status(404).send({ error: "Not found" });
      }

      const state = sharedState();
      const [connected, processes] = await Promise.all([state.connectedUsers(), state.runningProcesses()]);

      // Online now, or last seen within a day.
      const active = await db.query(
        `
        SELECT COUNT(*)::int AS count
        FROM users
        WHERE last_seen_at > NOW() - INTERVAL '1 day'
           OR id = ANY($1::uuid[])
        `,
        [[...connected.keys()]],
      );

      let sockets = 0;

      for (const count of connected.values()) {
        sockets += count;
      }

      return {
        online: connected.size,
        sockets,
        active24h: active.rows[0].count,
        processes,
      };
    },
  );
}
