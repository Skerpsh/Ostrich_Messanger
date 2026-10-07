// Adds a Content-Security-Policy to the static web build (npm run build:web).
// It is not in public/index.html because the dev server's hot reload
// evaluates code with eval(), which the policy forbids.
//
// Scripts may only come from the app's own origin, so injected markup
// cannot run code (e.g. to steal the session token from localStorage), and
// the page may only talk to the app's own origin and the API, so nothing
// can be sent elsewhere. Inline styles are allowed: react-native-web
// inserts them at runtime.
//
// frame-ancestors (no embedding in other sites) cannot be set in a <meta>
// tag; the web server sends it as a header, see ops/README.md.
import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// The API address the build uses: EXPO_PUBLIC_API_URL from the
// environment or the .env files Expo reads, else the default in
// src/lib/config.ts.
for (const file of [".env.production.local", ".env.local", ".env.production", ".env"]) {
  if (existsSync(file)) {
    // Does not override variables that are already set.
    process.loadEnvFile(file);
  }
}

function defaultApiUrl() {
  const config = readFileSync(path.join("src", "lib", "config.ts"), "utf8");
  const match = config.match(/EXPO_PUBLIC_API_URL \|\| "([^"]+)"/);

  if (!match) {
    throw new Error("src/lib/config.ts: default API URL not found");
  }

  return match[1];
}

const api = new URL(process.env.EXPO_PUBLIC_API_URL || defaultApiUrl());
const apiOrigin = api.origin;
const wsOrigin = apiOrigin.replace(/^http/, "ws");

const POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  // Avatars come from the API; expo-image may use blob: URLs.
  `img-src 'self' data: blob: ${apiOrigin}`,
  "font-src 'self' data:",
  `connect-src 'self' ${apiOrigin} ${wsOrigin}`,
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-src 'none'",
].join("; ");

const file = path.join(process.argv[2] ?? "dist", "index.html");
const html = await readFile(file, "utf8");

if (html.includes('http-equiv="Content-Security-Policy"')) {
  console.log(`${file}: Content-Security-Policy already present`);
} else {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${POLICY}" />`;

  // Right after <meta charset>, which has to stay first.
  const anchor = /<meta charset="[^"]*"\s*\/?>/i.test(html)
    ? /<meta charset="[^"]*"\s*\/?>/i
    : /<head>/i;

  if (!anchor.test(html)) {
    throw new Error(`${file}: <head> not found`);
  }

  await writeFile(file, html.replace(anchor, (tag) => `${tag}\n    ${meta}`));
  console.log(`${file}: added Content-Security-Policy (API ${apiOrigin})`);
}
