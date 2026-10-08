// What a message carries inside its encryption. Usually just its text;
// forwarded messages and messages with files carry a small JSON object
// after a marker instead, so the server sees none of it. The CLI reads the
// same format (cli/payload.go).

const MARKER = "\u001eostrich1:";

// A file of a message: encrypted with its own key (crypto.ts) and
// uploaded under its id.
export type Attachment = {
  id: string;
  // base64 of the file key.
  key: string;
  name: string;
  mime: string;
  // Bytes, before encryption.
  size: number;
  // Pictures: their size in pixels.
  width?: number;
  height?: number;
};

export type Payload = {
  text: string;
  // The username a forwarded message comes from.
  forwardedFrom?: string;
  attachments?: Attachment[];
};

type WireAttachment = { i: string; k: string; n: string; m: string; s: number; w?: number; h?: number };
type Wire = { t: string; f?: string; a?: WireAttachment[] };

export function encodePayload(payload: Payload): string {
  const attachments = payload.attachments ?? [];

  if (!payload.forwardedFrom && attachments.length === 0) {
    return payload.text;
  }

  const wire: Wire = { t: payload.text };

  if (payload.forwardedFrom) {
    wire.f = payload.forwardedFrom;
  }

  if (attachments.length > 0) {
    wire.a = attachments.map((a) => ({
      i: a.id,
      k: a.key,
      n: a.name,
      m: a.mime,
      s: a.size,
      ...(a.width && a.height ? { w: a.width, h: a.height } : {}),
    }));
  }

  return MARKER + JSON.stringify(wire);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readAttachment(value: unknown): Attachment | null {
  const a = value as Partial<WireAttachment> | null;

  if (
    !a ||
    typeof a.i !== "string" ||
    !UUID_RE.test(a.i) ||
    typeof a.k !== "string" ||
    typeof a.n !== "string" ||
    typeof a.m !== "string" ||
    typeof a.s !== "number"
  ) {
    return null;
  }

  return {
    id: a.i,
    key: a.k,
    name: a.n,
    mime: a.m,
    size: a.s,
    ...(typeof a.w === "number" && typeof a.h === "number" ? { width: a.w, height: a.h } : {}),
  };
}

// Anything that is not a well-formed payload is shown as text; malformed
// attachments are left out.
export function decodePayload(plain: string): Payload {
  if (!plain.startsWith(MARKER)) {
    return { text: plain };
  }

  try {
    const wire = JSON.parse(plain.slice(MARKER.length)) as Partial<Wire>;

    if (typeof wire.t !== "string") {
      return { text: plain };
    }

    const attachments = Array.isArray(wire.a)
      ? wire.a.map(readAttachment).filter((a): a is Attachment => a !== null)
      : [];

    return {
      text: wire.t,
      ...(typeof wire.f === "string" && wire.f ? { forwardedFrom: wire.f } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    };
  } catch {
    return { text: plain };
  }
}
