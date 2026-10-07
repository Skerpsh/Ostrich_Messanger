import { FastifyInstance } from "fastify";
import sharp from "sharp";
import { accountView } from "../accounts.js";
import { db, withTransaction } from "../database.js";
import { authenticate } from "../middleware/auth.js";
import { sendToContacts } from "../realtime.js";

// Uploads are re-encoded, so only common formats are accepted. Clients
// resize before uploading; the limit leaves room for an unresized photo.
const UPLOAD_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
// Refuses decompression bombs (tiny files that decode to huge images).
const MAX_INPUT_PIXELS = 40_000_000;

const AVATAR_SIZE = 512;

const uploadRateLimit = {
  rateLimit: {
    max: 10,
    timeWindow: "1 minute",
  },
};

// Chats lists load many avatars at once; they are cached by browsers and
// apps for good after the first load.
const downloadRateLimit = {
  rateLimit: {
    max: 600,
    timeWindow: "1 minute",
  },
};

// Square WebP without metadata (EXIF location, camera model, ...).
async function processAvatar(input: Buffer): Promise<Buffer> {
  return sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
    // Applies the EXIF orientation before the metadata is dropped.
    .rotate()
    .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover" })
    .webp({ quality: 82 })
    .toBuffer();
}

export default async function avatarsRoutes(server: FastifyInstance) {
  server.addContentTypeParser(
    UPLOAD_TYPES,
    { parseAs: "buffer", bodyLimit: MAX_UPLOAD_BYTES },
    (_request, body, done) => done(null, body),
  );

  const notifyProfile = (user: ReturnType<typeof accountView>) =>
    sendToContacts(user.id, {
      type: "profile",
      userId: user.id,
      username: user.username,
      avatarId: user.avatar_id,
      isDeveloper: user.is_developer,
    });

  // SET AVATAR: the request body is the image (Content-Type image/jpeg,
  // image/png or image/webp).
  server.put<{ Body: Buffer }>(
    "/api/users/me/avatar",
    {
      preHandler: authenticate,
      config: uploadRateLimit,
    },
    async (request, reply) => {
      if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
        return reply.status(415).send({
          error: "Send a JPEG, PNG or WebP image",
        });
      }

      let image: Buffer;

      try {
        image = await processAvatar(request.body);
      } catch {
        return reply.status(400).send({
          error: "This image cannot be used",
        });
      }

      // A new id for every upload: the old URL stops working and clients
      // fetch the new picture instead of a cached one.
      const avatarId = await withTransaction(async (client) => {
        await client.query("DELETE FROM avatars WHERE user_id = $1", [
          request.user.id,
        ]);

        const result = await client.query(
          `
          INSERT INTO avatars (user_id, image)
          VALUES ($1, $2)
          RETURNING id
          `,
          [request.user.id, image],
        );

        return result.rows[0].id as string;
      });

      const user = accountView({ ...request.user, avatar_id: avatarId });
      await notifyProfile(user);

      return { user };
    },
  );

  // REMOVE AVATAR
  server.delete(
    "/api/users/me/avatar",
    {
      preHandler: authenticate,
      config: uploadRateLimit,
    },
    async (request) => {
      await db.query("DELETE FROM avatars WHERE user_id = $1", [
        request.user.id,
      ]);

      const user = accountView({ ...request.user, avatar_id: null });
      await notifyProfile(user);

      return { user };
    },
  );

  // GET AVATAR: no session needed, so it works as a plain image URL; the
  // id is random and only handed out in authenticated responses.
  server.get<{ Params: { avatarId: string } }>(
    "/api/avatars/:avatarId",
    {
      config: downloadRateLimit,
      schema: {
        params: {
          type: "object",
          required: ["avatarId"],
          properties: {
            avatarId: { type: "string", format: "uuid" },
          },
        },
      },
    },
    async (request, reply) => {
      const result = await db.query("SELECT image FROM avatars WHERE id = $1", [
        request.params.avatarId,
      ]);

      if (result.rows.length === 0) {
        return reply.status(404).send({
          error: "Avatar not found",
        });
      }

      return reply
        .header("Content-Type", "image/webp")
        // A given id always has the same picture.
        .header("Cache-Control", "public, max-age=31536000, immutable")
        .header("X-Content-Type-Options", "nosniff")
        .send(result.rows[0].image);
    },
  );
}
