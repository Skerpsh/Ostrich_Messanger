import { Platform } from "react-native";
import { ApiError, getAttachmentBytes, SessionExpiredError } from "./api";
import { API_URL } from "./config";

// Files in the browser; see files.ts.

export async function readUri(uri: string): Promise<Uint8Array> {
  const response = await fetch(uri);
  return new Uint8Array(await response.arrayBuffer());
}

// Uploads with XMLHttpRequest, which (unlike fetch) reports progress:
// onProgress gets 0–1.
export function uploadSealed(
  token: string,
  id: string,
  sealed: Uint8Array,
  onProgress?: (done: number) => void,
) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.open("PUT", `${API_URL}/api/attachments/${encodeURIComponent(id)}`);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.setRequestHeader("X-Ostrich-Client", Platform.OS);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.timeout = 300_000;

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress?.(event.loaded / event.total);
      }
    };

    xhr.onload = () => {
      // 409: uploaded before, the answer got lost.
      if ((xhr.status >= 200 && xhr.status < 300) || xhr.status === 409) {
        resolve();
        return;
      }

      if (xhr.status === 401) {
        reject(new SessionExpiredError());
        return;
      }

      let message = `Upload failed (HTTP ${xhr.status})`;

      try {
        message = JSON.parse(xhr.responseText).error || message;
      } catch {
        // Not JSON.
      }

      reject(new ApiError(message, xhr.status));
    };

    xhr.onerror = xhr.ontimeout = () =>
      reject(new ApiError("Can't reach the server. Check your connection.", 0));

    xhr.send(new Blob([sealed as BlobPart], { type: "application/octet-stream" }));
  });
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
