// Account rules, the same as the backend's (backend/src/accounts.ts).

export const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
export const USERNAME_RULES = "Username: 3–32 characters, letters, digits, _ . - only";

export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 128;

// "@alice" → "alice".
export function cleanUsername(input: string) {
  return input.trim().replace(/^@/, "");
}
