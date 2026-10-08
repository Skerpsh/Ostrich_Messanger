import { mkdir, readdir, stat, statfs, unlink } from "node:fs/promises";
import path from "node:path";
import { db } from "./database.js";

// Where the encrypted files of messages are kept (see
// migrations/004_attachments.sql).
export const ATTACHMENTS_DIR =
  process.env.ATTACHMENTS_DIR || path.join(__dirname, "..", "data", "attachments");

// 25 MB of file, plus the nonce and tag of its encryption.
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024 + 40;

export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

// Uploads are refused when less disk space would be left.
const MIN_FREE_BYTES = 1024 * 1024 * 1024;

// Uploads never sent in a message are removed after this long.
const UNLINKED_TTL = "1 day";

// Files without a row are removed once they are this old (younger ones may
// belong to an upload in progress).
const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Files being written are named "<id>.part" until complete.
export const PART_SUFFIX = ".part";

// The file of an attachment; ids are UUIDs, checked here as well.
export function attachmentPath(id: string) {
  if (!UUID_RE.test(id)) {
    throw new Error("invalid attachment id");
  }

  return path.join(ATTACHMENTS_DIR, id.toLowerCase());
}

export async function ensureAttachmentsDir() {
  await mkdir(ATTACHMENTS_DIR, { recursive: true, mode: 0o700 });
}

// Whether there is room for a file of `size` bytes.
export async function hasRoomFor(size: number) {
  const disk = await statfs(ATTACHMENTS_DIR);

  return disk.bavail * disk.bsize - size > MIN_FREE_BYTES;
}

// Removes uploads never sent, and files whose message is gone.
export async function cleanupAttachments() {
  const expired = await db.query(
    `
    DELETE FROM attachments
    WHERE message_id IS NULL
      AND chat_id IS NULL
      AND created_at < NOW() - INTERVAL '${UNLINKED_TTL}'
    RETURNING id
    `,
  );

  for (const { id } of expired.rows) {
    await unlink(attachmentPath(id)).catch(() => {});
  }

  const names = await readdir(ATTACHMENTS_DIR);

  // Uploads cut off while being written.
  for (const name of names.filter((n) => n.endsWith(PART_SUFFIX))) {
    await removeIfOld(path.join(ATTACHMENTS_DIR, name));
  }

  const files = names.filter((name) => UUID_RE.test(name));

  for (let i = 0; i < files.length; i += 1000) {
    const batch = files.slice(i, i + 1000);
    const known = await db.query("SELECT id FROM attachments WHERE id = ANY($1::uuid[])", [batch]);
    const ids = new Set(known.rows.map((row) => String(row.id).toLowerCase()));

    for (const name of batch) {
      if (ids.has(name)) {
        continue;
      }

      await removeIfOld(path.join(ATTACHMENTS_DIR, name));
    }
  }
}

async function removeIfOld(file: string) {
  const info = await stat(file).catch(() => null);

  if (info && Date.now() - info.mtimeMs > ORPHAN_MIN_AGE_MS) {
    await unlink(file).catch(() => {});
  }
}
