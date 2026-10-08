import assert from "node:assert/strict";
import { test } from "node:test";
import { AlertTracker } from "../src/monitor/alerts.js";
import { bytes, dailySummary, duration, problems, report, short, type Thresholds } from "../src/monitor/report.js";
import { addSample, daysUntilFull, newDay } from "../src/monitor/state.js";
import type { BackendStats, Snapshot } from "../src/monitor/stats.js";

const GB = 1024 ** 3;
const MB = 1024 ** 2;

const limits: Thresholds = {
  diskMinFreePercent: 10,
  diskMinFreeBytes: 2 * GB,
  diskFullAlertDays: 14,
  memoryMinFreePercent: 5,
  backupMaxAgeHours: 26,
  slowResponseMs: 3000,
  logErrorsAlert: 20,
  failedLoginsAlert: 50,
  certificateMinDays: 14,
};

const at = new Date("2026-10-08T12:00:00Z");

const backendStats: BackendStats = {
  online: 56,
  sockets: 70,
  active24h: 300,
  processes: 1,
  process: { instanceId: "p1", uptimeSeconds: 7200, rssBytes: 180 * MB },
  counters: { requests: 1000, serverErrors: 0, rateLimited: 2, failedLogins: 3 },
};

function snapshot(change: Partial<Snapshot> = {}): Snapshot {
  return {
    at,
    database: {
      ok: true,
      counts: {
        users: 1200,
        newUsers24h: 12,
        messagesRecent: 40,
        messages24h: 5000,
        groups: 30,
        sessions: 900,
        databaseBytes: 120 * MB,
        attachments: 77,
        attachmentBytes: 3 * GB,
        connections: 12,
        maxConnections: 100,
      },
    },
    backends: [{ url: "http://127.0.0.1:3000", ok: true, latencyMs: 45, stats: backendStats }],
    disks: [{ labels: ["system", "files"], path: "/", free: 20 * GB, total: 40 * GB }],
    memory: { available: 2 * GB, total: 4 * GB, swapFree: GB, swapTotal: GB },
    cpuTimes: { idle: 100, total: 200 },
    network: { received: 0, sent: 0 },
    load: [0.1, 0.2, 0.3],
    cpus: 2,
    uptimeSeconds: 3 * 86400 + 4 * 3600,
    units: [{ name: "ostrich", active: "active", sub: "running", problem: false, restarts: 0 }],
    backup: { file: "ostrich-x.dump", at: new Date(at.getTime() - 8 * 3_600_000), size: 12 * MB },
    logErrors: { count: 0 },
    ...change,
  };
}

// Telegram refuses a whole message with bad HTML: only these tags, closed
// in order, and nothing but <b> inside the quote.
function assertTelegramHtml(html: string) {
  const stack: string[] = [];

  for (const [, closing, name] of html.matchAll(/<(\/?)([a-z]+)[^>]*>/g)) {
    assert.ok(["b", "code", "blockquote"].includes(name), `tag <${name}>`);

    if (closing) {
      assert.equal(stack.pop(), name);
    } else {
      assert.ok(name === "b" || stack.length === 0, `<${name}> inside <${stack.at(-1)}>`);
      stack.push(name);
    }
  }

  assert.deepEqual(stack, []);
  assert.doesNotMatch(html.replace(/<\/?[a-z]+[^>]*>/g, ""), /[<>]/);
}

test("monitor: sizes and durations", () => {
  assert.equal(bytes(512), "512 B");
  assert.equal(bytes(1.5 * GB), "1.5 GB");
  assert.equal(bytes(-250 * MB), "−250 MB");
  assert.equal(short(1_234_567), "1.2M");
  assert.equal(short(45_600), "46K");
  assert.equal(duration(59), "0m");
  assert.equal(duration(2 * 3600 + 5 * 60), "2h 5m");
  assert.equal(duration(3 * 86400 + 4 * 3600), "3d 4h");
});

test("monitor: report of a healthy server", () => {
  assert.deepEqual(problems(snapshot(), limits), []);

  const text = report(snapshot(), limits, 15, {
    previous: { users: 1197, online: 52, messagesRecent: 48 },
    peak: { online: 80, at },
    cpuPercent: 12,
    traffic: { requests: 500, serverErrors: 1, rateLimited: 0, failedLogins: 2 },
  });

  assertTelegramHtml(text);
  const [summary, details] = text.split("<blockquote expandable>");
  assert.match(summary, /all good/);
  assert.match(summary, /1,200 users \+3 · 56 online ▲4/);
  assert.match(summary, /disk 50% · ram 50% · cpu 12%/);
  assert.match(details, /Messages: 40 \/ 15 min ▼8/);
  assert.match(details, /peak 80 at/);
  assert.match(details, /Requests: 500 \/ 15 min · 5xx: 1/);
  assert.match(details, /█████░░░░░ 50%/);
});

test("monitor: report when things are wrong", () => {
  const text = report(
    snapshot({
      backends: [{ url: "http://127.0.0.1:3000", ok: true, latencyMs: 20, statsError: "HTTP 404" }],
      logErrors: { count: 3, top: "a <weird> error & more" },
      units: [{ name: "caddy", active: "failed", sub: "failed", problem: true, restarts: 4 }],
    }),
    limits,
    15,
  );

  assertTelegramHtml(text);
  assert.match(text, /1 problem/);
  assert.match(text, /Online: — \(HTTP 404\)/);
  assert.match(text, /a &lt;weird&gt; error &amp; more/);
  assert.match(text, /❌ caddy \(4 restarts\)/);
});

test("monitor: problems", () => {
  const found = problems(
    snapshot({
      backends: [
        { url: "http://127.0.0.1:3001", ok: false, error: "fetch failed" },
        { url: "http://127.0.0.1:3002", ok: true, latencyMs: 5000 },
      ],
      database: { ok: false, error: "connection refused" },
      units: [{ name: "caddy", active: "failed", sub: "failed", problem: true, restarts: 0 }],
      disks: [
        { labels: ["system"], path: "/", free: 1 * GB, total: 100 * GB },
        { labels: ["files"], path: "/data", free: 50 * GB, total: 100 * GB },
      ],
      memory: { available: 100 * MB, total: 4 * GB, swapFree: 0, swapTotal: 0 },
      backup: { file: "ostrich-x.dump", at: new Date(at.getTime() - 30 * 3_600_000), size: 1 },
    }),
    limits,
    {
      recentLogErrors: { count: 25, top: "boom" },
      recentFailedLogins: 60,
      diskFullInDays: new Map([["/data", 5]]),
      certificates: [
        { host: "api.example.com", expiresAt: new Date(at.getTime() + 3 * 86_400_000) },
        { host: "ok.example.com", expiresAt: new Date(at.getTime() + 60 * 86_400_000) },
      ],
    },
  );

  assert.deepEqual(
    found.map((problem) => problem.key),
    [
      "backend http://127.0.0.1:3001",
      "slow http://127.0.0.1:3002",
      "database",
      "unit caddy",
      "disk /",
      "disk forecast /data",
      "memory",
      "backup",
      "log errors",
      "failed logins",
      "tls api.example.com",
    ],
  );
});

test("monitor: daily summary", () => {
  const text = dailySummary({
    date: at,
    newUsers: 12,
    newUsersBefore: 10,
    messages: 5000,
    messagesBefore: 5000,
    peak: { online: 80, at },
    active: 300,
    totalUsers: 1200,
    traffic: { requests: 1_234_567, serverErrors: 3, rateLimited: 1, failedLogins: 40 },
    logErrors: { count: 14, top: "boom" },
    crashes: 0,
    databaseBytes: 120 * MB,
    databaseChange: 3 * MB,
    attachmentBytes: 3 * GB,
    attachmentChange: 120 * MB,
    disks: [{ label: "system", free: 20 * GB, change: -200 * MB, fullInDays: 29 }],
    updates: { pending: 12, security: 3, rebootRequired: true },
    backup: { at, size: 12 * MB },
  });

  assertTelegramHtml(text);
  assert.match(text, /New users: 12 \(▲20% vs the day before\)/);
  assert.match(text, /Messages: 5,000 \(same as the day before\)/);
  assert.match(text, /Requests: 1.2M/);
  assert.match(text, /Database: 120 MB \(\+3 MB\)/);
  assert.match(text, /20 GB free \(\+200 MB used\) · full in ~29d/);
  assert.match(text, /12 updates \(3 security\) · reboot required/);
});

test("monitor: disk forecast", () => {
  const state = newDay(at);
  const day = 86_400_000;

  // Filling up 1 GB a day.
  for (let hour = 0; hour <= 48; hour += 6) {
    addSample(state, new Date(at.getTime() + hour * 3_600_000), { "/": 10 * GB + (hour / 24) * GB });
  }

  assert.equal(Math.round(daysUntilFull(state, "/", 20 * GB)!), 20);
  assert.equal(daysUntilFull(state, "/data", 20 * GB), undefined);

  // Not filling up: no forecast.
  const flat = newDay(at);

  for (let i = 0; i < 5; i++) {
    addSample(flat, new Date(at.getTime() + i * day), { "/": 10 * GB });
  }

  assert.equal(daysUntilFull(flat, "/", 20 * GB), undefined);
});

test("monitor: alerts after repeated checks, cleared once gone", () => {
  const tracker = new AlertTracker(2);
  const down = { key: "backend", text: "down" };

  assert.deepEqual(tracker.update([down]), { raised: [], cleared: [] });
  assert.deepEqual(tracker.update([down]), { raised: [down], cleared: [] });
  // Raised once only.
  assert.deepEqual(tracker.update([{ key: "backend", text: "still down" }]), { raised: [], cleared: [] });
  assert.deepEqual(tracker.update([]), { raised: [], cleared: [{ key: "backend", text: "still down" }] });

  // Seen once (a restart): no alert, nothing to clear.
  assert.deepEqual(tracker.update([down]), { raised: [], cleared: [] });
  assert.deepEqual(tracker.update([]), { raised: [], cleared: [] });
});
