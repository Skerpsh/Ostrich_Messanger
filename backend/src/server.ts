import Fastify, { FastifyError, FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import rateLimit from "@fastify/rate-limit";
import cors from "@fastify/cors";

import { db, isPgError, PG_INVALID_TEXT } from "./database.js";

import authRoutes from "./routes/auth.js";
import usersRoutes from "./routes/users.js";
import chatsRoutes from "./routes/chats.js";
import messagesRoutes from "./routes/messages.js";
import avatarsRoutes from "./routes/avatars.js";
import websocketRoutes from "./routes/websocket.js";

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

// Which proxies may set X-Forwarded-For (used for rate limiting). By default
// only a reverse proxy on the same machine, e.g. nginx on the VPS.
// Also accepts "true"/"false".
const TRUST_PROXY = parseTrustProxy(process.env.TRUST_PROXY || "loopback");

function parseTrustProxy(value: string): boolean | string {
  if (value === "true" || value === "false") {
    return value === "true";
  }

  return value;
}

// Origins allowed to call the API from a browser (Ostrich Web), comma
// separated. Any origin by default: auth uses bearer tokens, not cookies,
// so other sites cannot act on behalf of a user.
const CORS_ORIGINS = process.env.CORS_ORIGINS?.split(",").map((o) => o.trim());

const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

const server = Fastify({
  trustProxy: TRUST_PROXY,
  logger: {
    serializers: {
      // Never write credentials from URLs (?token=, ?ticket=) to the logs.
      req(request) {
        return {
          method: request.method,
          url: request.url.replace(
            /([?&](?:token|ticket)=)[^&]*/g,
            "$1[redacted]",
          ),
          remoteAddress: request.ip,
        };
      },
    },
  },
});

server.setErrorHandler((error: FastifyError, request, reply) => {
  if (error.validation) {
    return reply.status(400).send({
      error: error.message,
    });
  }

  if (isPgError(error, PG_INVALID_TEXT)) {
    return reply.status(400).send({
      error: "Invalid identifier",
    });
  }

  if (error.statusCode && error.statusCode < 500) {
    return reply.status(error.statusCode).send({
      error: error.message,
    });
  }

  request.log.error(error);

  return reply.status(500).send({
    error: "Internal server error",
  });
});

// Registered after the rate limit plugin, so its limit applies.
async function healthRoutes(instance: FastifyInstance) {
  instance.get(
    "/api/health",
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: "1 minute",
        },
      },
    },
    async () => {
      await db.query("SELECT 1");

      return {
        status: "ok",
        database: "connected",
      };
    },
  );
}

async function deleteExpiredSessions() {
  try {
    await db.query("DELETE FROM sessions WHERE expires_at <= NOW()");
  } catch (error) {
    server.log.error(error, "failed to delete expired sessions");
  }
}

const start = async () => {
  try {
    if (!CORS_ORIGINS && process.env.NODE_ENV === "production") {
      server.log.warn(
        "CORS_ORIGINS is not set: the API accepts browser requests from any origin",
      );
    }

    await server.register(cors, {
      origin: CORS_ORIGINS ?? true,
      // PUT/DELETE: avatar upload and removal from the web app.
      methods: ["GET", "HEAD", "POST", "PUT", "DELETE"],
    });

    await server.register(rateLimit, {
      // Only routes with a `rateLimit` config are limited.
      global: false,
    });

    await server.register(websocket, {
      options: {
        maxPayload: 64 * 1024,
      },
    });

    await server.register(healthRoutes);
    await server.register(websocketRoutes);
    await server.register(authRoutes);
    await server.register(usersRoutes);
    await server.register(chatsRoutes);
    await server.register(messagesRoutes);
    await server.register(avatarsRoutes);

    await server.listen({
      port: PORT,
      host: HOST,
    });

    deleteExpiredSessions();
    setInterval(deleteExpiredSessions, SESSION_CLEANUP_INTERVAL_MS).unref();
  } catch (error) {
    server.log.error(error);
    process.exit(1);
  }
};

const shutdown = async () => {
  try {
    await server.close();
    await db.end();
  } finally {
    process.exit(0);
  }
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start();
