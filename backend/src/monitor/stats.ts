import { execFile } from "node:child_process";
import { access, readdir, readFile, stat, statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { promisify } from "node:util";
import { ATTACHMENTS_DIR } from "../attachments.js";
import { db } from "../database.js";

const run = promisify(execFile);

// What the monitoring sees of the server at one moment. Counters (CPU
// time, network bytes, requests) are raw totals: main.ts takes the
// differences between snapshots.

export type Counts = {
  users: number;
  newUsers24h: number;
  messagesRecent: number;
  messages24h: number;
  groups: number;
  sessions: number;
  databaseBytes: number;
  attachments: number;
  attachmentBytes: number;
  connections: number;
  maxConnections: number;
};

// From a backend process (routes/monitor.ts).
export type BackendCounters = {
  requests: number;
  serverErrors: number;
  rateLimited: number;
  failedLogins: number;
};

export type BackendStats = {
  online: number;
  sockets: number;
  active24h?: number;
  processes: number;
  process: { instanceId: string; uptimeSeconds: number; rssBytes: number };
  counters: BackendCounters;
};

export type BackendCheck = {
  url: string;
  ok: boolean;
  error?: string;
  latencyMs?: number;
  stats?: BackendStats;
  statsError?: string;
};

// One filesystem; `labels` are what is kept on it (system, files, ...).
export type Disk = { labels: string[]; path: string; free: number; total: number };

export type Unit = { name: string; active: string; sub: string; problem: boolean; restarts: number };

export type Backup = { file: string; at: Date; size: number };

export type LogErrors = { count: number; top?: string };

export type Certificate = { host: string; expiresAt?: Date; error?: string };

export type Updates = { pending?: number; security?: number; rebootRequired: boolean };

export type Snapshot = {
  at: Date;
  // A failed part has an `error` instead.
  database: { ok: true; counts?: Counts } | { ok: false; error: string };
  backends: BackendCheck[];
  disks: Disk[];
  memory: { available: number; total: number; swapFree: number; swapTotal: number };
  // /proc/stat and /proc/net/dev totals (null: not Linux).
  cpuTimes: { idle: number; total: number } | null;
  network: { received: number; sent: number } | null;
  load: number[];
  cpus: number;
  uptimeSeconds: number;
  // null: systemd not available here.
  units: Unit[] | null;
  // null: no backups (yet); undefined: no backup directory.
  backup: Backup | null | undefined;
  // Errors the backend logged within `logMinutes` (null: no journal).
  logErrors: LogErrors | null;
};

export type CollectOptions = {
  backendUrls: string[];
  monitorSecret?: string;
  // systemd unit names or patterns, e.g. "ostrich*".
  services: string[];
  backupDir: string;
  // Messages are counted for this many minutes back too.
  recentMinutes: number;
  // Log errors are counted for this many minutes back.
  logMinutes: number;
  // Also count users, messages, ... (heavier: for reports, not every check).
  counts: boolean;
};

const TIMEOUT_MS = 10_000;

export function errorText(error: unknown) {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? `${error.message}: ${cause.message}` : error.message;
  }

  return String(error);
}

function withTimeout<T>(promise: Promise<T>, ms = TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no answer in ${ms / 1000} s`)), ms).unref()),
  ]);
}

async function database(options: CollectOptions): Promise<Snapshot["database"]> {
  try {
    if (!options.counts) {
      await withTimeout(db.query("SELECT 1"));
      return { ok: true };
    }

    const result = await withTimeout(
      db.query(
        `
        SELECT
          (SELECT COUNT(*) FROM users)::int AS users,
          (SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '1 day')::int AS new_users,
          (SELECT COUNT(*) FROM messages WHERE created_at > NOW() - make_interval(mins => $1))::int AS messages_recent,
          (SELECT COUNT(*) FROM messages WHERE created_at > NOW() - INTERVAL '1 day')::int AS messages_day,
          (SELECT COUNT(*) FROM chats WHERE type = 'group')::int AS groups,
          (SELECT COUNT(*) FROM sessions WHERE expires_at > NOW())::int AS sessions,
          pg_database_size(current_database())::bigint AS database_bytes,
          (SELECT COUNT(*) FROM attachments)::int AS attachments,
          (SELECT COALESCE(SUM(size), 0) FROM attachments)::bigint AS attachment_bytes,
          (SELECT COUNT(*) FROM pg_stat_activity)::int AS connections,
          current_setting('max_connections')::int AS max_connections
        `,
        [options.recentMinutes],
      ),
    );
    const row = result.rows[0];

    return {
      ok: true,
      counts: {
        users: row.users,
        newUsers24h: row.new_users,
        messagesRecent: row.messages_recent,
        messages24h: row.messages_day,
        groups: row.groups,
        sessions: row.sessions,
        databaseBytes: Number(row.database_bytes),
        attachments: row.attachments,
        attachmentBytes: Number(row.attachment_bytes),
        connections: row.connections,
        maxConnections: row.max_connections,
      },
    };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

// New users and messages of a period, for the daily summary.
export async function periodCounts(from: Date, to: Date) {
  const result = await withTimeout(
    db.query(
      `
      SELECT
        (SELECT COUNT(*) FROM users WHERE created_at >= $1 AND created_at < $2)::int AS new_users,
        (SELECT COUNT(*) FROM messages WHERE created_at >= $1 AND created_at < $2)::int AS messages
      `,
      [from, to],
    ),
  );

  return { newUsers: result.rows[0].new_users as number, messages: result.rows[0].messages as number };
}

async function checkBackend(url: string, options: CollectOptions): Promise<BackendCheck> {
  const started = performance.now();

  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const latencyMs = Math.round(performance.now() - started);

    if (!response.ok) {
      return { url, ok: false, error: `HTTP ${response.status}`, latencyMs };
    }

    const check: BackendCheck = { url, ok: true, latencyMs };

    if (!options.monitorSecret) {
      check.statsError = "MONITOR_SECRET is not set";
      return check;
    }

    try {
      const stats = await fetch(`${url}/api/internal/stats${options.counts ? "?full=1" : ""}`, {
        headers: { authorization: `Bearer ${options.monitorSecret}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (stats.ok) {
        check.stats = (await stats.json()) as BackendStats;
      } else {
        // 404: the backend has no MONITOR_SECRET, or another one.
        check.statsError = `HTTP ${stats.status}`;
      }
    } catch (error) {
      check.statsError = errorText(error);
    }

    return check;
  } catch (error) {
    return { url, ok: false, error: errorText(error) };
  }
}

async function disks(backupDir: string) {
  const places: [string, string][] = [
    ["system", "/"],
    ["files", ATTACHMENTS_DIR],
    ["backups", backupDir],
  ];
  const byDevice = new Map<number, Disk>();

  for (const [label, place] of places) {
    try {
      const [info, fs] = await Promise.all([stat(place), statfs(place)]);
      const disk = byDevice.get(info.dev);

      if (disk) {
        disk.labels.push(label);
      } else {
        byDevice.set(info.dev, {
          labels: [label],
          path: place,
          free: fs.bavail * fs.bsize,
          total: fs.blocks * fs.bsize,
        });
      }
    } catch {
      // Not there (e.g. no backups yet).
    }
  }

  return [...byDevice.values()];
}

// MemAvailable counts caches that can be freed; os.freemem() does not.
async function memory(): Promise<Snapshot["memory"]> {
  const total = os.totalmem();

  try {
    const info = await readFile("/proc/meminfo", "utf8");
    const kb = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+) kB`, "m").exec(info)?.[1] ?? NaN) * 1024;
    const available = kb("MemAvailable");

    if (Number.isFinite(available)) {
      return { available, total, swapFree: kb("SwapFree") || 0, swapTotal: kb("SwapTotal") || 0 };
    }
  } catch {
    // Not Linux.
  }

  return { available: os.freemem(), total, swapFree: 0, swapTotal: 0 };
}

async function cpuTimes() {
  try {
    const line = (await readFile("/proc/stat", "utf8")).split("\n")[0];
    // cpu user nice system idle iowait irq softirq steal ...
    const values = line.trim().split(/\s+/).slice(1).map(Number);
    const total = values.slice(0, 8).reduce((sum, value) => sum + value, 0);

    return { idle: values[3] + (values[4] ?? 0), total };
  } catch {
    return null;
  }
}

async function network() {
  try {
    let received = 0;
    let sent = 0;

    for (const line of (await readFile("/proc/net/dev", "utf8")).split("\n").slice(2)) {
      const [name, data] = line.split(":");

      if (!data || name.trim() === "lo") {
        continue;
      }

      const values = data.trim().split(/\s+/).map(Number);
      received += values[0];
      sent += values[8];
    }

    return { received, sent };
  } catch {
    return null;
  }
}

// Services worth watching: running, failed, or enabled to run. A oneshot
// (the backup) is a problem only when it failed.
async function units(patterns: string[]): Promise<Unit[] | null> {
  if (patterns.length === 0) {
    return [];
  }

  try {
    const listed = await run(
      "systemctl",
      ["list-units", "--all", "--plain", "--no-legend", "--no-pager", "--type=service", "--", ...patterns],
      { timeout: TIMEOUT_MS },
    );
    const names = listed.stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/).find((word) => word.endsWith(".service")))
      .filter((name): name is string => !!name);

    if (names.length === 0) {
      return [];
    }

    const shown = await run(
      "systemctl",
      ["show", "--no-pager", "--property=Id,ActiveState,SubState,UnitFileState,Type,NRestarts", "--", ...names],
      { timeout: TIMEOUT_MS },
    );

    return shown.stdout
      .trim()
      .split(/\n\s*\n/)
      .map((block) => Object.fromEntries(block.split("\n").map((line) => line.split(/=(.*)/s, 2))))
      .map((props: Record<string, string>) => {
        const enabled = props.UnitFileState?.startsWith("enabled") ?? false;
        const oneshot = props.Type === "oneshot";
        const problem =
          props.ActiveState === "failed" || (enabled && !oneshot && props.ActiveState !== "active");

        return {
          name: props.Id.replace(/\.service$/, ""),
          active: props.ActiveState,
          sub: props.SubState,
          problem,
          restarts: Number(props.NRestarts) || 0,
          shown: problem || props.ActiveState === "active" || enabled,
        };
      })
      .filter((unit) => unit.shown)
      .map(({ shown: _, ...unit }) => unit)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return null;
  }
}

// The backend's own units: ostrich, ostrich@3001, ... (not the bot or the
// backup).
export function backendUnits(list: Unit[] | null) {
  return (list ?? []).map((unit) => unit.name).filter((name) => /^ostrich(@.+)?$/.test(name));
}

// Errors the backend logged (Fastify's JSON lines, level 50 and up) in a
// period, and the most frequent one.
export async function logErrors(unitNames: string[], since: string, until?: string): Promise<LogErrors | null> {
  if (unitNames.length === 0) {
    return { count: 0 };
  }

  try {
    const { stdout } = await run(
      "journalctl",
      [
        ...unitNames.flatMap((name) => ["-u", name]),
        "--since",
        since,
        ...(until ? ["--until", until] : []),
        "-o",
        "cat",
        "--no-pager",
        "-q",
      ],
      { timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
    );
    const messages = new Map<string, number>();
    let count = 0;

    for (const line of stdout.split("\n")) {
      if (!line.startsWith("{")) {
        continue;
      }

      try {
        const entry = JSON.parse(line) as { level?: number; msg?: string; err?: { message?: string } };

        if ((entry.level ?? 0) >= 50) {
          count++;
          const message = (entry.err?.message ?? entry.msg ?? "error").slice(0, 120);
          messages.set(message, (messages.get(message) ?? 0) + 1);
        }
      } catch {
        // Not a log entry.
      }
    }

    const top = [...messages].sort((a, b) => b[1] - a[1])[0]?.[0];

    return { count, top };
  } catch {
    return null;
  }
}

// The newest backup of ops/backup.sh.
async function lastBackup(dir: string): Promise<Backup | null | undefined> {
  let names: string[];

  try {
    names = await readdir(dir);
  } catch {
    return undefined;
  }

  let newest: Backup | null = null;

  for (const name of names) {
    if (!/^ostrich-.*\.dump$/.test(name)) {
      continue;
    }

    try {
      const info = await stat(path.join(dir, name));

      if (!newest || info.mtime > newest.at) {
        newest = { file: name, at: info.mtime, size: info.size };
      }
    } catch {
      // Removed meanwhile.
    }
  }

  return newest;
}

// The sites in Caddy's config (they get certificates), e.g. "api.example.com".
export async function caddySites(file = "/etc/caddy/Caddyfile") {
  let text: string;

  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }

  const hosts = new Set<string>();

  for (const line of text.split("\n")) {
    // A site block starts at the beginning of a line: "a.com, b.com {".
    const match = /^([^\s#{(][^{]*)\{\s*$/.exec(line);

    if (!match) {
      continue;
    }

    for (const address of match[1].split(/[\s,]+/).filter(Boolean)) {
      if (address.startsWith("http://")) {
        continue;
      }

      const host = address.replace(/^https:\/\//, "").replace(/:\d+$/, "").replace(/\/.*$/, "");

      if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host) && !/^[\d.]+$/.test(host)) {
        hosts.add(host.toLowerCase());
      }
    }
  }

  return [...hosts];
}

export function certificate(host: string): Promise<Certificate> {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false, timeout: TIMEOUT_MS });

    const done = (result: Certificate) => {
      socket.destroy();
      resolve(result);
    };

    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate();

      if (!cert?.valid_to) {
        done({ host, error: "no certificate" });
      } else if (!socket.authorized) {
        done({ host, expiresAt: new Date(cert.valid_to), error: String(socket.authorizationError) });
      } else {
        done({ host, expiresAt: new Date(cert.valid_to) });
      }
    });
    socket.once("timeout", () => done({ host, error: "timeout" }));
    socket.once("error", (error) => done({ host, error: error.message }));
  });
}

// Ubuntu's pending updates (update-notifier's apt-check) and whether they
// need a reboot.
export async function systemUpdates(): Promise<Updates> {
  const rebootRequired = await access("/var/run/reboot-required").then(
    () => true,
    () => false,
  );

  try {
    // Prints "<updates>;<security updates>" to stderr.
    const { stderr } = await run("/usr/lib/update-notifier/apt-check", [], { timeout: 60_000 });
    const [pending, security] = stderr.trim().split(";").map(Number);

    return { pending, security, rebootRequired };
  } catch {
    return { rebootRequired };
  }
}

export async function collect(options: CollectOptions): Promise<Snapshot> {
  const unitsPromise = units(options.services);
  const logPromise = unitsPromise.then((list) =>
    list === null ? null : logErrors(backendUnits(list), `-${options.logMinutes}min`),
  );

  const [databaseResult, backends, disksResult, memoryResult, cpu, net, unitsResult, backup, logs] =
    await Promise.all([
      database(options),
      Promise.all(options.backendUrls.map((url) => checkBackend(url, options))),
      disks(options.backupDir),
      memory(),
      cpuTimes(),
      network(),
      unitsPromise,
      lastBackup(options.backupDir),
      logPromise,
    ]);

  return {
    at: new Date(),
    database: databaseResult,
    backends,
    disks: disksResult,
    memory: memoryResult,
    cpuTimes: cpu,
    network: net,
    load: os.loadavg(),
    cpus: os.cpus().length,
    uptimeSeconds: os.uptime(),
    units: unitsResult,
    backup,
    logErrors: logs,
  };
}
