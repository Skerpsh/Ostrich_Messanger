import { db } from "../database.js";
import { AlertTracker } from "./alerts.js";
import {
  dailySummary,
  escapeHtml,
  problems,
  problemsText,
  report,
  type DaySummary,
  type Extras,
  type Thresholds,
} from "./report.js";
import { addSample, daysUntilFull, emptyCounters, loadState, localDay, newDay, saveState, type State } from "./state.js";
import {
  backendUnits,
  caddySites,
  certificate,
  collect,
  logErrors,
  periodCounts,
  systemUpdates,
  type BackendCounters,
  type Certificate,
  type CollectOptions,
  type Snapshot,
  type Updates,
} from "./stats.js";
import { Telegram } from "./telegram.js";

// The monitoring bot: a process of its own next to the backend (see
// "Monitoring bot" in ops/README.md). It reports to Telegram every
// MONITOR_REPORT_MINUTES and sends a summary of each day at midnight,
// checks the server every MONITOR_CHECK_SECONDS and alerts at once when
// something breaks, and answers commands. Only the chats in
// MONITOR_CHAT_IDS get anything.

function list(value: string | undefined, fallback: string[]) {
  const items = value?.split(/[\s,]+/).filter(Boolean);
  return items && items.length > 0 ? items : fallback;
}

function positive(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const BOT_TOKEN = process.env.MONITOR_BOT_TOKEN;
const CHAT_IDS = new Set(list(process.env.MONITOR_CHAT_IDS, []));
const REPORT_MINUTES = positive("MONITOR_REPORT_MINUTES", 15);
const CHECK_SECONDS = positive("MONITOR_CHECK_SECONDS", 60);
const ALERT_AFTER = positive("MONITOR_ALERT_AFTER", 2);
const STATE_FILE = process.env.MONITOR_STATE_FILE || "/var/lib/ostrich-monitor/state.json";
// Sites whose certificates to watch; by default those in Caddy's config.
const TLS_HOSTS = list(process.env.MONITOR_TLS_HOSTS, []);

// Errors and failed logins are alerted on when too many within these.
const LOG_ALERT_MINUTES = 5;
const LOGIN_ALERT_MINUTES = 15;
// Certificates and system updates change slowly.
const SLOW_CHECK_MS = 6 * 3_600_000;
const SAMPLE_EVERY_MS = 3_600_000;

const collectOptions: Omit<CollectOptions, "counts" | "logMinutes"> = {
  // Several processes (ostrich@3001 ...): all their addresses.
  backendUrls: list(process.env.MONITOR_BACKEND_URLS, ["http://127.0.0.1:3000"]).map((url) => url.replace(/\/+$/, "")),
  monitorSecret: process.env.MONITOR_SECRET || undefined,
  services: list(process.env.MONITOR_SERVICES, ["ostrich*", "postgresql*", "redis*", "caddy*"]),
  backupDir: process.env.BACKUP_DIR || "/var/backups/ostrich",
  recentMinutes: REPORT_MINUTES,
};

const thresholds: Thresholds = {
  diskMinFreePercent: positive("MONITOR_DISK_MIN_FREE_PERCENT", 10),
  diskMinFreeBytes: positive("MONITOR_DISK_MIN_FREE_GB", 2) * 1024 ** 3,
  diskFullAlertDays: positive("MONITOR_DISK_FULL_ALERT_DAYS", 14),
  memoryMinFreePercent: positive("MONITOR_MEMORY_MIN_FREE_PERCENT", 5),
  // A daily backup, and some slack.
  backupMaxAgeHours: positive("MONITOR_BACKUP_MAX_AGE_HOURS", 26),
  slowResponseMs: positive("MONITOR_SLOW_MS", 3000),
  logErrorsAlert: positive("MONITOR_LOG_ERRORS_ALERT", 20),
  failedLoginsAlert: positive("MONITOR_FAILED_LOGINS_ALERT", 50),
  // Caddy renews 30 days ahead: less means renewing fails.
  certificateMinDays: positive("MONITOR_CERT_MIN_DAYS", 14),
};

if (!BOT_TOKEN) {
  console.error("monitor: MONITOR_BOT_TOKEN is not set (see ops/README.md)");
  process.exit(1);
}

const telegram = new Telegram(BOT_TOKEN);
const tracker = new AlertTracker(ALERT_AFTER);

let state: State;

// Each backend process's counters at the last check (by process id).
const lastCounters = new Map<string, BackendCounters>();
// Since the last report.
let periodTraffic = emptyCounters();
// Failed logins of each check, for the alert window.
const loginWindow: { at: number; count: number }[] = [];
// systemd restarts of each unit at the last check.
const lastRestarts = new Map<string, number>();
// CPU and network totals at the last report.
let lastCpu: Snapshot["cpuTimes"] = null;
let lastNetwork: Snapshot["network"] = null;

let certificates: Certificate[] = [];
let updates: Updates | undefined;
let slowCheckedAt = 0;

async function sendAll(html: string, silent: boolean) {
  for (const chatId of CHAT_IDS) {
    try {
      await telegram.send(chatId, html, { silent });
    } catch (error) {
      console.error(`monitor: cannot send to ${chatId}:`, error);
    }
  }
}

function addCounters(to: BackendCounters, add: BackendCounters) {
  to.requests += add.requests;
  to.serverErrors += add.serverErrors;
  to.rateLimited += add.rateLimited;
  to.failedLogins += add.failedLogins;
}

// What each process counted since the last check (all of it after a
// restart, when its counters start over).
function takeCounters(snapshot: Snapshot) {
  const total = emptyCounters();

  for (const check of snapshot.backends) {
    if (!check.stats) {
      continue;
    }

    const { instanceId } = check.stats.process;
    const now = check.stats.counters;
    const before = lastCounters.get(instanceId);
    const restarted = !before || now.requests < before.requests;

    const from = restarted ? emptyCounters() : before;
    addCounters(total, {
      requests: now.requests - from.requests,
      serverErrors: now.serverErrors - from.serverErrors,
      rateLimited: now.rateLimited - from.rateLimited,
      failedLogins: now.failedLogins - from.failedLogins,
    });

    lastCounters.set(instanceId, { ...now });
  }

  return total;
}

function diskForecasts(snapshot: Snapshot) {
  return new Map(
    snapshot.disks.flatMap((disk) => {
      const days = daysUntilFull(state, disk.path, disk.free);
      return days === undefined ? [] : [[disk.path, days] as const];
    }),
  );
}

async function refreshSlowChecks() {
  if (Date.now() - slowCheckedAt < SLOW_CHECK_MS) {
    return;
  }

  slowCheckedAt = Date.now();
  const hosts = TLS_HOSTS.length > 0 ? TLS_HOSTS : await caddySites();
  [certificates, updates] = await Promise.all([Promise.all(hosts.map(certificate)), systemUpdates()]);
}

// A new day is started by the daily summary at midnight; here only if
// that did not happen (the bot was down at midnight, or `force` on start).
function startDayIfNew(snapshot: Snapshot, force = false) {
  const sinceMidnight = snapshot.at.getTime() - startOfDay(snapshot.at).getTime();

  if (state.day === localDay(snapshot.at) || (!force && sinceMidnight < 10 * 60_000)) {
    return;
  }

  state = newDay(snapshot.at, state);
  state.dayStart = { diskFree: Object.fromEntries(snapshot.disks.map((disk) => [disk.path, disk.free])) };
}

async function check() {
  const snapshot = await collect({ ...collectOptions, counts: false, logMinutes: LOG_ALERT_MINUTES });
  const now = snapshot.at.getTime();

  startDayIfNew(snapshot);
  state.dayStart ??= { diskFree: Object.fromEntries(snapshot.disks.map((disk) => [disk.path, disk.free])) };

  const traffic = takeCounters(snapshot);
  addCounters(periodTraffic, traffic);
  addCounters(state.traffic, traffic);
  loginWindow.push({ at: now, count: traffic.failedLogins });

  while (loginWindow.length > 0 && loginWindow[0].at < now - LOGIN_ALERT_MINUTES * 60_000) {
    loginWindow.shift();
  }

  const online = snapshot.backends.find((c) => c.stats)?.stats?.online;

  if (online !== undefined && (!state.peak || online > state.peak.online)) {
    state.peak = { online, at: snapshot.at.toISOString() };
  }

  // A restart by systemd: the process crashed (deploys restart by hand,
  // which systemd does not count).
  for (const unit of snapshot.units ?? []) {
    const before = lastRestarts.get(unit.name);

    if (before !== undefined && unit.restarts > before) {
      state.crashes += unit.restarts - before;
      console.warn(`monitor: ${unit.name} crashed`);
      await sendAll(`💥 <b>${escapeHtml(unit.name)}</b> crashed and was restarted by systemd (${unit.restarts} restarts so far)`, false);
    }

    lastRestarts.set(unit.name, unit.restarts);
  }

  const lastSample = state.samples[state.samples.length - 1]?.at ?? 0;

  if (now - lastSample >= SAMPLE_EVERY_MS) {
    addSample(state, snapshot.at, Object.fromEntries(snapshot.disks.map((disk) => [disk.path, disk.total - disk.free])));
  }

  await refreshSlowChecks();

  const extras: Extras = {
    recentLogErrors: snapshot.logErrors,
    recentFailedLogins: loginWindow.reduce((sum, entry) => sum + entry.count, 0),
    diskFullInDays: diskForecasts(snapshot),
    certificates,
  };
  const { raised, cleared } = tracker.update(problems(snapshot, thresholds, extras));

  for (const problem of raised) {
    console.warn(`monitor: problem: ${problem.text}`);
    await sendAll(`🚨 ${escapeHtml(problem.text)}`, false);
  }

  for (const problem of cleared) {
    console.log(`monitor: resolved: ${problem.text}`);
    await sendAll(`✅ Fixed: ${escapeHtml(problem.text)}`, false);
  }

  await saveState(STATE_FILE, state);
}

function percentBusy(before: Snapshot["cpuTimes"], now: Snapshot["cpuTimes"]) {
  if (!before || !now || now.total <= before.total) {
    return undefined;
  }

  return Math.round((1 - (now.idle - before.idle) / (now.total - before.total)) * 100);
}

// `scheduled`: the periodic report, which starts the next period; /stats
// only looks.
async function fullReport(scheduled: boolean) {
  const snapshot = await collect({ ...collectOptions, counts: true, logMinutes: REPORT_MINUTES });
  const counts = snapshot.database.ok ? snapshot.database.counts : undefined;
  const online = snapshot.backends.find((c) => c.stats)?.stats?.online;

  const extras: Extras = {
    previous: state.previous,
    peak: state.peak ? { online: state.peak.online, at: new Date(state.peak.at) } : undefined,
    cpuPercent: percentBusy(lastCpu, snapshot.cpuTimes),
    network:
      lastNetwork && snapshot.network
        ? { received: snapshot.network.received - lastNetwork.received, sent: snapshot.network.sent - lastNetwork.sent }
        : undefined,
    traffic: { ...periodTraffic },
    diskFullInDays: diskForecasts(snapshot),
    certificates,
    updates,
  };

  if (scheduled) {
    lastCpu = snapshot.cpuTimes;
    lastNetwork = snapshot.network;
    periodTraffic = emptyCounters();

    if (counts && online !== undefined) {
      state.previous = { users: counts.users, online, messagesRecent: counts.messagesRecent };
    }

    if (counts && state.dayStart && state.dayStart.databaseBytes === undefined) {
      state.dayStart.databaseBytes = counts.databaseBytes;
      state.dayStart.attachmentBytes = counts.attachmentBytes;
    }
  }

  return report(snapshot, thresholds, REPORT_MINUTES, extras);
}

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const addDays = (date: Date, days: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);

// The summary of a day: yesterday at midnight, or today so far (/today).
async function summary(today: boolean) {
  const now = new Date();
  const from = today ? startOfDay(now) : addDays(startOfDay(now), -1);
  const to = today ? now : startOfDay(now);
  // The same span of the day before, to compare.
  const before = [addDays(from, -1), new Date(to.getTime() - 86_400_000)] as const;

  const snapshot = await collect({ ...collectOptions, counts: true, logMinutes: REPORT_MINUTES });
  const counts = snapshot.database.ok ? snapshot.database.counts : undefined;
  const [day, dayBefore, logs] = await Promise.all([
    periodCounts(from, to).catch(() => undefined),
    periodCounts(...before).catch(() => undefined),
    snapshot.units === null ? null : logErrors(backendUnits(snapshot.units), today ? "today" : "yesterday", today ? undefined : "today"),
  ]);
  const start = state.dayStart;

  const data: DaySummary = {
    date: from,
    newUsers: day?.newUsers ?? 0,
    newUsersBefore: dayBefore?.newUsers,
    messages: day?.messages ?? 0,
    messagesBefore: dayBefore?.messages,
    peak: state.peak ? { online: state.peak.online, at: new Date(state.peak.at) } : undefined,
    active: snapshot.backends.find((c) => c.stats)?.stats?.active24h,
    totalUsers: counts?.users,
    traffic: state.traffic,
    logErrors: logs,
    crashes: state.crashes,
    databaseBytes: counts?.databaseBytes,
    databaseChange: counts && start?.databaseBytes !== undefined ? counts.databaseBytes - start.databaseBytes : undefined,
    attachmentBytes: counts?.attachmentBytes,
    attachmentChange:
      counts && start?.attachmentBytes !== undefined ? counts.attachmentBytes - start.attachmentBytes : undefined,
    disks: snapshot.disks.map((disk) => ({
      label: disk.labels.join(", "),
      free: disk.free,
      change: start?.diskFree[disk.path] !== undefined ? disk.free - start.diskFree[disk.path] : undefined,
      fullInDays: daysUntilFull(state, disk.path, disk.free),
    })),
    updates,
    backup: snapshot.backup ? { at: snapshot.backup.at, size: snapshot.backup.size } : snapshot.backup,
  };

  if (!today) {
    // The new day starts from here.
    state = newDay(now, state);
    state.dayStart = {
      databaseBytes: counts?.databaseBytes,
      attachmentBytes: counts?.attachmentBytes,
      diskFree: Object.fromEntries(snapshot.disks.map((disk) => [disk.path, disk.free])),
    };
    await saveState(STATE_FILE, state);
  }

  return dailySummary(data);
}

const HELP = [
  "/stats — full report now",
  "/today — today so far",
  "/health — any problems now",
  "/id — this chat's id",
].join("\n");

async function answer(chatId: string, text: string) {
  // "/stats@SomeBot args" in groups.
  const command = text.trim().split(/\s+/)[0].replace(/@.*$/, "").toLowerCase();

  if (command === "/id") {
    await telegram.send(chatId, `chat id: <code>${escapeHtml(chatId)}</code>`);
    return;
  }

  if (!CHAT_IDS.has(chatId)) {
    // Anyone may write to a bot: others only learn their chat id, to set
    // the bot up.
    if (command === "/start") {
      await telegram.send(chatId, `chat id: <code>${escapeHtml(chatId)}</code>`);
    }

    return;
  }

  if (command === "/stats") {
    await telegram.send(chatId, await fullReport(false));
  } else if (command === "/today") {
    await telegram.send(chatId, await summary(true));
  } else if (command === "/health") {
    const snapshot = await collect({ ...collectOptions, counts: false, logMinutes: LOG_ALERT_MINUTES });
    await telegram.send(
      chatId,
      problemsText(problems(snapshot, thresholds, { recentLogErrors: snapshot.logErrors, diskFullInDays: diskForecasts(snapshot), certificates })),
    );
  } else if (command === "/start" || command === "/help") {
    await telegram.send(
      chatId,
      `<b>Ostrich monitoring</b>\nA report every ${REPORT_MINUTES} min, a daily summary at midnight, alerts right away.\n\n${HELP}`,
    );
  }
}

async function listen() {
  for (;;) {
    try {
      for (const message of await telegram.receive()) {
        await answer(message.chatId, message.text).catch((error) => console.error("monitor: cannot answer:", error));
      }
    } catch (error) {
      console.error("monitor: cannot get messages:", error);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
}

// Runs `task` every `ms` (first after `firstInMs`), never two at once.
function every(ms: number, task: () => Promise<void>, firstInMs = ms) {
  const next = (delay: number) =>
    setTimeout(async () => {
      const started = Date.now();

      try {
        await task();
      } catch (error) {
        console.error("monitor:", error);
      }

      next(Math.max(ms - (Date.now() - started), 1_000));
    }, delay);

  next(firstInMs);
}

// Reports at round times: :00, :15, :30, :45.
function scheduleReports() {
  const ms = REPORT_MINUTES * 60_000;

  const next = () => {
    setTimeout(async () => {
      try {
        await sendAll(await fullReport(true), true);
      } catch (error) {
        console.error("monitor: report failed:", error);
      }

      next();
    }, ms - (Date.now() % ms));
  };

  next();
}

// The daily summary at local midnight (a few seconds after, so the day's
// last messages are in).
function scheduleDailySummary() {
  const next = () => {
    const midnight = addDays(startOfDay(new Date()), 1).getTime() + 5_000;

    setTimeout(async () => {
      try {
        await sendAll(await summary(false), true);
      } catch (error) {
        console.error("monitor: daily summary failed:", error);
      }

      next();
    }, midnight - Date.now());
  };

  next();
}

async function main() {
  state = await loadState(STATE_FILE);

  // Baselines for the first report's CPU and network.
  const first = await collect({ ...collectOptions, counts: false, logMinutes: LOG_ALERT_MINUTES });
  lastCpu = first.cpuTimes;
  lastNetwork = first.network;
  takeCounters(first);
  startDayIfNew(first, true);

  for (const unit of first.units ?? []) {
    lastRestarts.set(unit.name, unit.restarts);
  }

  await refreshSlowChecks();

  if (CHAT_IDS.size === 0) {
    console.warn("monitor: MONITOR_CHAT_IDS is empty: send /start to the bot to get the chat id");
  } else {
    await sendAll(`🟢 <b>Monitoring started</b>\n\n${await fullReport(false)}`, true);
  }

  every(CHECK_SECONDS * 1000, check, 0);
  scheduleReports();
  scheduleDailySummary();
  listen();

  console.log(`monitor: running, reports every ${REPORT_MINUTES} min to ${CHAT_IDS.size} chat(s)`);
}

const shutdown = async () => {
  try {
    if (state) {
      await saveState(STATE_FILE, state);
    }

    await db.end();
  } finally {
    process.exit(0);
  }
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((error) => {
  console.error("monitor:", error);
  process.exit(1);
});
