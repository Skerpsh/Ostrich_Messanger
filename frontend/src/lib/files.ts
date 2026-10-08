import { Platform } from "react-native";
import { File, Paths, UploadType } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { ApiError, SessionExpiredError } from "./api";
import { API_URL } from "./config";
import { toBase64 } from "./crypto";

// Files on iOS / Android: reading picked files, uploading and downloading
// encrypted attachments through temporary files (React Native's fetch
// cannot send or read raw bytes reliably), showing and saving decrypted
// ones. The web implementation lives in files.web.ts. Decrypted files
// never stay on the disk: pictures are shown from memory, and a file
// saved through the share sheet is removed afterwards.

const headers = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "X-Ostrich-Client": Platform.OS,
});

const url = (id: string) => `${API_URL}/api/attachments/${encodeURIComponent(id)}`;

export async function readUri(uri: string): Promise<Uint8Array> {
  return new File(uri).bytes();
}

function failed(status: number, body: string): never {
  if (status === 401) {
    throw new SessionExpiredError();
  }

  let message = `Upload failed (HTTP ${status})`;

  try {
    message = JSON.parse(body).error || message;
  } catch {}

  throw new ApiError(message, status);
}

// onProgress (0–1) is not reported on the phones.
export async function uploadSealed(
  token: string,
  id: string,
  sealed: Uint8Array,
  _onProgress?: (done: number) => void,
) {
  const file = new File(Paths.cache, `upload-${id}`);

  try {
    file.write(sealed);

    const result = await file.upload(url(id), {
      httpMethod: "PUT",
      uploadType: UploadType.BINARY_CONTENT,
      headers: { ...headers(token), "Content-Type": "application/octet-stream" },
    });

    // 409: uploaded before, the answer got lost.
    if ((result.status < 200 || result.status >= 300) && result.status !== 409) {
      failed(result.status, result.body);
    }
  } catch (e) {
    if (e instanceof ApiError) {
      throw e;
    }

    throw new ApiError("Can't reach the server. Check your connection.", 0);
  } finally {
    if (file.exists) {
      file.delete();
    }
  }
}

export async function downloadSealed(token: string, id: string): Promise<Uint8Array> {
  const file = new File(Paths.cache, `download-${id}`);

  try {
    await File.downloadFileAsync(url(id), file, { headers: headers(token), idempotent: true });
    return await file.bytes();
  } catch (e) {
    const status = Number(/\b(\d{3})\b/.exec(String(e))?.[1]);

    if (status === 401) {
      throw new SessionExpiredError();
    }

    throw new ApiError(
      status ? `Download failed (HTTP ${status})` : "Can't reach the server. Check your connection.",
      status || 0,
    );
  } finally {
    if (file.exists) {
      file.delete();
    }
  }
}

// A picture to show, from memory.
export function imageSource(bytes: Uint8Array, mime: string) {
  return `data:${mime};base64,${toBase64(bytes)}`;
}

// Hands a decrypted file to the system's share sheet (save to Files,
// send to another app, …).
export async function saveFile(bytes: Uint8Array, name: string, mime: string) {
  const file = new File(Paths.cache, safeFileName(name));

  try {
    if (file.exists) {
      file.delete();
    }

    file.write(bytes);
    await Sharing.shareAsync(file.uri, { mimeType: mime, dialogTitle: name });
  } finally {
    if (file.exists) {
      file.delete();
    }
  }
}

// A name from another user, usable as a file name: no folders, no
// control characters, not hidden.
export function safeFileName(name: string) {
  const clean = name
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "_")
    .replace(/^[.\s]+/, "")
    .trim()
    .slice(0, 120);

  return clean || "attachment";
}
