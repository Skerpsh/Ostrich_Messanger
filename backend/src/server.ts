import Fastify from "fastify";
import websocket from "@fastify/websocket";

import { db } from "./database.js";
import { authenticate } from "./middleware/auth.js";

import authRoutes from "./routes/auth.js";
import usersRoutes from "./routes/users.js";
import chatsRoutes from "./routes/chats.js";
import messagesRoutes from "./routes/messages.js";
import websocketRoutes from "./routes/websocket.js";

const server = Fastify({
  logger: true,
});

server.get("/api/health", async () => {
  const result = await db.query("SELECT NOW()");

  return {
    status: "ok",
    database: "connected",
    time: result.rows[0].now,
  };
});

server.get(
  "/api/test-auth",
  {
    preHandler: authenticate,
  },
  async (request) => {
    return {
      message: "Authentication successful",
      user: request.user,
    };
  },
);

const start = async () => {
  try {
    await server.register(websocket);
    await server.register(websocketRoutes);

    await server.register(authRoutes);
    await server.register(usersRoutes);
    await server.register(chatsRoutes);
    await server.register(messagesRoutes);

    await server.listen({
      port: 3000,
      host: "0.0.0.0",
    });
  } catch (error) {
    server.log.error(error);
    process.exit(1);
  }
};

start();
