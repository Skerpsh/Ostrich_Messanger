// Adds a Content-Security-Policy to the static web build (npm run build:web).
// It is not in public/index.html because the dev server's hot reload
// evaluates code with eval(), which the policy forbids.
//
// Scripts may only come from the app's own origin, so injected markup
// cannot run code (e.g. to steal the session token from localStorage).
// Inline styles are allowed: react-native-web inserts them at runtime.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const POLICY = [
  "script-src 'self'",
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
  console.log(`${file}: added Content-Security-Policy`);
}
