import { access, copyFile, rename, unlink, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { FastifyInstance } from "fastify";
import {
  attachmentPath,
  hasRoomFor,
  MAX_ATTACHMENT_BYTES,
  PART_SUFFIX,
} from "../attachments.js";
import { db, isPgError, PG_UNIQUE_VIOLATION } from "../database.js";
import { authenticate } from "../middleware/auth.js";

// Encrypted files of messages: upload, copy (forwarding), download. The
// client encrypts a file before uploading it and chooses its id; the file
// is linked to a message when the message is sent (messages.ts).

const uploadRateLimit = {
  rateLimit: {
    max: 30,
    timeWindow: "1 minute",
  },
};

// Chats show many pictures at once.
const downloadRateLimit = {
  rateLimit: {
    max: 300,
    timeWindow: "1 minute",
  },
};

const idParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", format: "uuid" } },
} as const;

// SQL: whether user $2 may read attachment $1: they uploaded it, or it is
// in a message of a chat they are in (and have not cleared).
const CAN_READ = `
  SELECT a.size
  FROM attachments a
  LEFT JOIN messages m ON m.id = a.message_id
  WHERE a.id = $1
    AND (
      a.uploader_id = $2
      OR EXISTS (
        SELECT 1 FROM chat_members cm
        WHERE cm.chat_id = m.chat_id
          AND cm.user_id = $2
          AND (cm.cleared_at IS NULL OR m.created_at > cm.cleared_at)
      )
    )
`;

const ID_TAKEN = "An attachment with this id already exists";

export default async function attachmentsRoutes(server: FastifyInstance) {
  server.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: MAX_ATTACHMENT_BYTES },
    (_request, body, done) => done(null, body),
  );

  // UPLOAD an encrypted file under the id the client chose.
  server.put<{ Params: { id: string }; Body: Buffer }>(
    "/api/attachments/:id",
    {
      preHandler: authenticate,
      config: uploadRateLimit,
      schema: { params: idParams },
    },
    async (request, reply) => {
      const { id } = request.params;
      const data = request.body;

      if (!Buffer.isBuffer(data) || data.length === 0) {
        return reply.status(415).send({ error: "Send the file as application/octet-stream" });
      }

      if (!(await hasRoomFor(data.length))) {
        request.log.error("attachments: not enough disk space");
        return reply.status(507).send({ error: "The server is out of space, try later" });
      }

      try {
        await db.query("INSERT INTO attachments (id, uploader_id, size) VALUES ($1, $2, $3)", [
          id,
          request.user.id,
          data.length,
        ]);
      } catch (error) {
        if (isPgError(error, PG_UNIQUE_VIOLATION)) {
          return reply.status(409).send({ error: ID_TAKEN });
        }

        throw error;
      }

      const file = attachmentPath(id);

      try {
        // Written aside and renamed, so a file is never seen half written.
        await writeFile(file + PART_SUFFIX, data, { mode: 0o600 });
        await rename(file + PART_SUFFIX, file);
      } catch (error) {
        await db.query("DELETE FROM attachments WHERE id = $1", [id]).catch(() => {});
        await unlink(file + PART_SUFFIX).catch(() => {});
        throw error;
      }

      return reply.status(201).send({ id, size: data.length });
    },
  );

  // COPY an attachment the user can read under a new id, to forward it
  // without uploading it again (its key stays the same).
  server.post<{ Params: { id: string }; Body: { id: string } }>(
    "/api/attachments/:id/copy",
    {
      preHandler: authenticate,
      config: uploadRateLimit,
      schema: {
        params: idParams,
        body: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
      },
    },
    async (request, reply) => {
      const source = request.params.id;
      const target = request.body.id;

      const readable = await db.query(CAN_READ, [source, request.user.id]);
      const exists = await access(attachmentPath(source)).then(() => true, () => false);

      if (readable.rows.length === 0 || !exists) {
        return reply.status(404).send({ error: "Attachment not found" });
      }

      const size = readable.rows[0].size as number;

      if (!(await hasRoomFor(size))) {
        return reply.status(507).send({ error: "The server is out of space, try later" });
      }

      try {
        await db.query("INSERT INTO attachments (id, uploader_id, size) VALUES ($1, $2, $3)", [
          target,
          request.user.id,
          size,
        ]);
      } catch (error) {
        if (isPgError(error, PG_UNIQUE_VIOLATION)) {
          return reply.status(409).send({ error: ID_TAKEN });
        }

        throw error;
      }

      try {
        await copyFile(attachmentPath(source), attachmentPath(target) + PART_SUFFIX);
        await rename(attachmentPath(target) + PART_SUFFIX, attachmentPath(target));
      } catch (error) {
        await db.query("DELETE FROM attachments WHERE id = $1", [target]).catch(() => {});
        await unlink(attachmentPath(target) + PART_SUFFIX).catch(() => {});
        throw error;
      }

      return reply.status(201).send({ id: target, size });
    },
  );

  // DOWNLOAD an encrypted file.
  server.get<{ Params: { id: string } }>(
    "/api/attachments/:id",
    {
      preHandler: authenticate,
      config: downloadRateLimit,
      schema: { params: idParams },
    },
    async (request, reply) => {
      const { id } = request.params;
      const readable = await db.query(CAN_READ, [id, request.user.id]);

      const file = attachmentPath(id);

      if (readable.rows.length === 0 || !(await access(file).then(() => true, () => false))) {
        return reply.status(404).send({ error: "Attachment not found" });
      }

      return reply
        .header("Content-Type", "application/octet-stream")
        .header("Content-Length", String(readable.rows[0].size))
        // An id always has the same content; only for this user's cache.
        .header("Cache-Control", "private, max-age=31536000, immutable")
        .header("X-Content-Type-Options", "nosniff")
        .send(createReadStream(file));
    },
  );
}
