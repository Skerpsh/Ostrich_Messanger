import { db } from "../database.js";
import { AlertTracker } from "./alerts.js";
import { escapeHtml, problems, problemsText, report, type Thresholds } from "./report.js";
import { collect, type CollectOptions } from "./stats.js";
import { Telegram } from "./telegram.js";

// The monitoring bot: a process of its own next to the backend (see
// "Monitoring bot" in ops/README.md). It reports to Telegram every
// MONITOR_REPORT_MINUTES, checks the server every MONITOR_CHECK_SECONDS
// and alerts at once when something breaks, and answers /stats and
// /health. Only the chats in MONITOR_CHAT_IDS get anything.

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

const collectOptions: Omit<CollectOptions, "counts"> = {
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
  memoryMinFreePercent: positive("MONITOR_MEMORY_MIN_FREE_PERCENT", 5),
  // A daily backup, and some slack.
  backupMaxAgeHours: positive("MONITOR_BACKUP_MAX_AGE_HOURS", 26),
};

if (!BOT_TOKEN) {
  console.error("monitor: MONITOR_BOT_TOKEN is not set (see ops/README.md)");
  process.exit(1);
}

const telegram = new Telegram(BOT_TOKEN);
const tracker = new AlertTracker(ALERT_AFTER);

async function sendAll(html: string, silent: boolean) {
  for (const chatId of CHAT_IDS) {
    try {
      await telegram.send(chatId, html, { silent });
    } catch (error) {
      console.error(`monitor: cannot send to ${chatId}:`, error);
    }
  }
}

async function fullReport() {
  const snapshot = await collect({ ...collectOptions, counts: true });
  return report(snapshot, thresholds, REPORT_MINUTES);
}

async function check() {
  const snapshot = await collect({ ...collectOptions, counts: false });
  const { raised, cleared } = tracker.update(problems(snapshot, thresholds));

  for (const problem of raised) {
    console.warn(`monitor: problem: ${problem.text}`);
    await sendAll(`🚨 ${escapeHtml(problem.text)}`, false);
  }

  for (const problem of cleared) {
    console.log(`monitor: resolved: ${problem.text}`);
    await sendAll(`✅ Исправлено: ${escapeHtml(problem.text)}`, false);
  }
}

const HELP = [
  "/stats — статистика сейчас",
  "/health — есть ли проблемы",
  "/id — id этого чата",
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
    await telegram.send(chatId, await fullReport());
  } else if (command === "/health") {
    const snapshot = await collect({ ...collectOptions, counts: false });
    await telegram.send(chatId, problemsText(problems(snapshot, thresholds)));
  } else if (command === "/start" || command === "/help") {
    await telegram.send(chatId, `Мониторинг Ostrich. Отчёт каждые ${REPORT_MINUTES} мин, тревога сразу.\n\n${HELP}`);
  }
}

async function listen() {
  for (;;) {
    try {
      for (const message of await telegram.receive()) {
        await answer(message.chatId, message.text).catch((error) =>
          console.error("monitor: cannot answer:", error),
        );
      }
    } catch (error) {
      console.error("monitor: cannot get messages:", error);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
}

// Runs `task` now and then every `ms`, never two at once.
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
        await sendAll(await fullReport(), true);
      } catch (error) {
        console.error("monitor: report failed:", error);
      }

      next();
    }, ms - (Date.now() % ms));
  };

  next();
}

async function main() {
  if (CHAT_IDS.size === 0) {
    console.warn("monitor: MONITOR_CHAT_IDS is empty: send /start to the bot to get the chat id");
  } else {
    await sendAll(`🟢 Мониторинг запущен\n\n${await fullReport()}`, true);
  }

  every(CHECK_SECONDS * 1000, check, 0);
  scheduleReports();
  listen();

  console.log(`monitor: running, reports every ${REPORT_MINUTES} min to ${CHAT_IDS.size} chat(s)`);
}

const shutdown = async () => {
  try {
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
