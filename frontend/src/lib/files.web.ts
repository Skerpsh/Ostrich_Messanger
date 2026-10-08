import { ApiError, getAttachmentBytes, putAttachment } from "./api";

// Files in the browser; see files.ts.

export async function readUri(uri: string): Promise<Uint8Array> {
  const response = await fetch(uri);
  return new Uint8Array(await response.arrayBuffer());
}

export async function uploadSealed(token: string, id: string, sealed: Uint8Array) {
  try {
    await putAttachment(token, id, new Blob([sealed as BlobPart], { type: "application/octet-stream" }));
  } catch (e) {
    // 409: uploaded before, the answer got lost.
    if (!(e instanceof ApiError) || e.status !== 409) {
      throw e;
    }
  }
}

export function downloadSealed(token: string, id: string) {
  return getAttachmentBytes(token, id);
}

// A picture to show, from memory (released with the page).
export function imageSource(bytes: Uint8Array, mime: string) {
  return URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
}

// Downloads a decrypted file.
export async function saveFile(bytes: Uint8Array, name: string, mime: string) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  link.download = safeFileName(name);
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
}

export function safeFileName(name: string) {
  const clean = name
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "_")
    .replace(/^[.\s]+/, "")
    .trim()
    .slice(0, 120);

  return clean || "attachment";
}
