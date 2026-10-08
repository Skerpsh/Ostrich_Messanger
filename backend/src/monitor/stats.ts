import { execFile } from "node:child_process";
import { readdir, readFile, stat, statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ATTACHMENTS_DIR } from "../attachments.js";
import { db } from "../database.js";

const run = promisify(execFile);

// What the monitoring sees of the server at one moment.

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
};

// From the backend itself (routes/monitor.ts).
export type BackendStats = {
  online: number;
  sockets: number;
  active24h: number;
  processes: number;
};

export type BackendCheck = { url: string; ok: boolean; error?: string };

// One filesystem; `labels` are what is kept on it (system, attachments, ...).
export type Disk = { labels: string[]; path: string; free: number; total: number };

export type Unit = { name: string; active: string; sub: string; problem: boolean };

export type Backup = { file: string; at: Date; size: number };

export type Snapshot = {
  at: Date;
  // A failed part has an `error` instead.
  database: { ok: true; counts?: Counts } | { ok: false; error: string };
  backends: BackendCheck[];
  backendStats: BackendStats | { error: string } | null;
  disks: Disk[];
  memory: { available: number; total: number };
  load: number[];
  cpus: number;
  uptimeSeconds: number;
  // null: systemd not available here.
  units: Unit[] | null;
  // null: no backups (yet); undefined: no backup directory.
  backup: Backup | null | undefined;
};

export type CollectOptions = {
  backendUrls: string[];
  monitorSecret?: string;
  // systemd unit names or patterns, e.g. "ostrich*".
  services: string[];
  backupDir: string;
  // Messages are counted for this many minutes back too.
  recentMinutes: number;
  // Also count users, messages, ... (heavier: for reports, not every check).
  counts: boolean;
};

const TIMEOUT_MS = 10_000;

function errorText(error: unknown) {
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
          (SELECT COALESCE(SUM(size), 0) FROM attachments)::bigint AS attachment_bytes
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
      },
    };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

async function checkBackend(url: string): Promise<BackendCheck> {
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(TIMEOUT_MS) });

    if (!response.ok) {
      return { url, ok: false, error: `HTTP ${response.status}` };
    }

    return { url, ok: true };
  } catch (error) {
    return { url, ok: false, error: errorText(error) };
  }
}

async function backendStats(url: string, secret: string | undefined): Promise<Snapshot["backendStats"]> {
  if (!secret) {
    return { error: "MONITOR_SECRET is not set" };
  }

  try {
    const response = await fetch(`${url}/api/internal/stats`, {
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      // 404: the backend has no MONITOR_SECRET, or another one.
      return { error: `HTTP ${response.status}` };
    }

    return (await response.json()) as BackendStats;
  } catch (error) {
    return { error: errorText(error) };
  }
}

async function disks(backupDir: string) {
  const places: [string, string][] = [
    ["система", "/"],
    ["вложения", ATTACHMENTS_DIR],
    ["бэкапы", backupDir],
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
async function memory() {
  const total = os.totalmem();

  try {
    const match = /^MemAvailable:\s+(\d+) kB/m.exec(await readFile("/proc/meminfo", "utf8"));

    if (match) {
      return { available: Number(match[1]) * 1024, total };
    }
  } catch {
    // Not Linux.
  }

  return { available: os.freemem(), total };
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
      ["show", "--no-pager", "--property=Id,ActiveState,SubState,UnitFileState,Type", "--", ...names],
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

export async function collect(options: CollectOptions): Promise<Snapshot> {
  const backendsPromise = Promise.all(options.backendUrls.map(checkBackend));
  // From any process that answers: they all see the same.
  const statsPromise = options.counts
    ? backendsPromise.then((checks) => {
        const up = checks.find((check) => check.ok);
        return up ? backendStats(up.url, options.monitorSecret) : null;
      })
    : Promise.resolve(null);

  const [databaseResult, backends, stats, disksResult, memoryResult, unitsResult, backup] = await Promise.all([
    database(options),
    backendsPromise,
    statsPromise,
    disks(options.backupDir),
    memory(),
    units(options.services),
    lastBackup(options.backupDir),
  ]);

  return {
    at: new Date(),
    database: databaseResult,
    backends,
    backendStats: stats,
    disks: disksResult,
    memory: memoryResult,
    load: os.loadavg(),
    cpus: os.cpus().length,
    uptimeSeconds: os.uptime(),
    units: unitsResult,
    backup,
  };
}
