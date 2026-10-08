import assert from "node:assert/strict";
import { test } from "node:test";
import { AlertTracker } from "../src/monitor/alerts.js";
import { bytes, duration, problems, report, type Thresholds } from "../src/monitor/report.js";
import type { Snapshot } from "../src/monitor/stats.js";

const GB = 1024 ** 3;

const limits: Thresholds = {
  diskMinFreePercent: 10,
  diskMinFreeBytes: 2 * GB,
  memoryMinFreePercent: 5,
  backupMaxAgeHours: 26,
};

function snapshot(change: Partial<Snapshot> = {}): Snapshot {
  const at = new Date("2026-10-08T12:00:00Z");

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
        databaseBytes: 120 * 1024 ** 2,
        attachments: 77,
        attachmentBytes: 3 * GB,
      },
    },
    backends: [{ url: "http://127.0.0.1:3000", ok: true }],
    backendStats: { online: 56, sockets: 70, active24h: 300, processes: 1 },
    disks: [{ labels: ["система", "вложения"], path: "/", free: 20 * GB, total: 40 * GB }],
    memory: { available: 2 * GB, total: 4 * GB },
    load: [0.1, 0.2, 0.3],
    cpus: 2,
    uptimeSeconds: 3 * 86400 + 4 * 3600,
    units: [{ name: "ostrich", active: "active", sub: "running", problem: false }],
    backup: { file: "ostrich-x.dump", at: new Date(at.getTime() - 8 * 3_600_000), size: 12 * 1024 ** 2 },
    ...change,
  };
}

test("monitor: sizes and durations", () => {
  assert.equal(bytes(512), "512 Б");
  assert.equal(bytes(1.5 * GB), "1,5 ГБ");
  assert.equal(bytes(250 * 1024 ** 2), "250 МБ");
  assert.equal(duration(59), "0 мин");
  assert.equal(duration(2 * 3600 + 5 * 60), "2 ч 5 мин");
  assert.equal(duration(3 * 86400 + 4 * 3600), "3 д 4 ч");
});

test("monitor: a healthy server has no problems", () => {
  assert.deepEqual(problems(snapshot(), limits), []);

  const text = report(snapshot(), limits, 15);
  assert.match(text, /Всего: 1\s200 \(\+12 за сутки\)/);
  assert.match(text, /Онлайн: 56/);
  assert.match(text, /40 за 15 мин/);
  assert.doesNotMatch(text, /Проблемы/);
});

test("monitor: problems", () => {
  const at = new Date("2026-10-08T12:00:00Z");
  const found = problems(
    snapshot({
      backends: [{ url: "http://127.0.0.1:3000", ok: false, error: "fetch failed" }],
      database: { ok: false, error: "connection refused" },
      units: [{ name: "caddy", active: "failed", sub: "failed", problem: true }],
      disks: [{ labels: ["система"], path: "/", free: 1 * GB, total: 100 * GB }],
      memory: { available: 100 * 1024 ** 2, total: 4 * GB },
      backup: { file: "ostrich-x.dump", at: new Date(at.getTime() - 30 * 3_600_000), size: 1 },
    }),
    limits,
  );

  assert.deepEqual(
    found.map((problem) => problem.key),
    ["backend http://127.0.0.1:3000", "database", "unit caddy", "disk /", "memory", "backup"],
  );

  const text = report(snapshot({ backendStats: { error: "HTTP 404" } }), limits, 15);
  assert.match(text, /Онлайн: — \(HTTP 404\)/);
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
