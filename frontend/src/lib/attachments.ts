import * as api from "./api";
import { decryptAttachment, encryptAttachment, newMessageId } from "./crypto";
import { downloadSealed, uploadSealed } from "./files";
import type { Attachment } from "./payload";

// Files of messages: encrypted on this device before uploading, decrypted
// after downloading (crypto.ts); the server only ever has ciphertext.

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;

// A file chosen to send.
export type PickedFile = {
  bytes: Uint8Array;
  name: string;
  mime: string;
  width?: number;
  height?: number;
  // For the preview before sending.
  previewUri?: string;
};

export const isImage = (mime: string) => /^image\/(jpeg|png|gif|webp)$/.test(mime);

export async function uploadAttachment(token: string, file: PickedFile): Promise<Attachment> {
  if (file.bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new api.ApiError("Files can be up to 25 MB", 400);
  }

  const id = newMessageId();
  const { key, sealed } = encryptAttachment(file.bytes);

  await uploadSealed(token, id, sealed);

  return {
    id,
    key,
    name: file.name,
    mime: file.mime,
    size: file.bytes.length,
    ...(file.width && file.height ? { width: file.width, height: file.height } : {}),
  };
}

// Decrypted files, kept in memory for a while (pictures in a chat are
// drawn again and again).
const loaded = new Map<string, Promise<Uint8Array>>();
const KEPT = 40;

export function loadAttachment(token: string, attachment: Attachment): Promise<Uint8Array> {
  let bytes = loaded.get(attachment.id);

  if (!bytes) {
    bytes = downloadSealed(token, attachment.id).then((sealed) =>
      decryptAttachment(sealed, attachment.key),
    );
    bytes.catch(() => loaded.delete(attachment.id));
    loaded.set(attachment.id, bytes);

    // The oldest go first.
    for (const id of loaded.keys()) {
      if (loaded.size <= KEPT) {
        break;
      }

      loaded.delete(id);
    }
  }

  return bytes;
}

// Forget the decrypted files (logging out).
export function forgetLoadedAttachments() {
  loaded.clear();
}

// Copies attachments on the server for forwarding: new ids, same keys.
export async function copyAttachments(token: string, attachments: Attachment[]) {
  const copies: Attachment[] = [];

  for (const attachment of attachments) {
    const id = newMessageId();
    await api.copyAttachment(token, attachment.id, id);
    copies.push({ ...attachment, id });
  }

  return copies;
}

// "1.2 MB".
export function formatSize(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// What a message with files says in previews when it has no text.
export function attachmentsLabel(attachments: Attachment[] | undefined) {
  if (!attachments?.length) {
    return "";
  }

  if (attachments.length > 1) {
    return attachments.every((a) => isImage(a.mime))
      ? `🖼 ${attachments.length} photos`
      : `📎 ${attachments.length} files`;
  }

  return isImage(attachments[0].mime) ? "🖼 Photo" : `📎 ${attachments[0].name}`;
}
