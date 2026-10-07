// What a message carries inside its encryption. Usually just its text;
// forwarded messages (and, later, attachments) carry a small JSON object
// after a marker instead, so the server sees none of it. The CLI reads the
// same format (cli/payload.go).

const MARKER = "\u001eostrich1:";

export type Payload = {
  text: string;
  // The username a forwarded message comes from.
  forwardedFrom?: string;
};

type Wire = { t: string; f?: string };

export function encodePayload(payload: Payload): string {
  if (!payload.forwardedFrom) {
    return payload.text;
  }

  const wire: Wire = { t: payload.text, f: payload.forwardedFrom };

  return MARKER + JSON.stringify(wire);
}

// Anything that is not a well-formed payload is shown as text.
export function decodePayload(plain: string): Payload {
  if (!plain.startsWith(MARKER)) {
    return { text: plain };
  }

  try {
    const wire = JSON.parse(plain.slice(MARKER.length)) as Partial<Wire>;

    if (typeof wire.t !== "string") {
      return { text: plain };
    }

    return {
      text: wire.t,
      ...(typeof wire.f === "string" && wire.f ? { forwardedFrom: wire.f } : {}),
    };
  } catch {
    return { text: plain };
  }
}
