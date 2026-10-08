import type { BackendCounters, Certificate, Counts, LogErrors, Snapshot, Updates } from "./stats.js";

// What the monitoring says: problems, the report (a short summary with
// details in an expandable quote) and the daily summary, as Telegram HTML.

export type Thresholds = {
  // A disk is low when less than either is free.
  diskMinFreePercent: number;
  diskMinFreeBytes: number;
  // ... or when it will be full within this many days.
  diskFullAlertDays: number;
  memoryMinFreePercent: number;
  // Older is a problem (only once there are backups).
  backupMaxAgeHours: number;
  slowResponseMs: number;
  // Within the alert window (main.ts).
  logErrorsAlert: number;
  failedLoginsAlert: number;
  certificateMinDays: number;
};

// What main.ts works out between snapshots.
export type Extras = {
  // Since the previous report.
  previous?: { users: number; online: number; messagesRecent: number };
  peak?: { online: number; at: Date };
  cpuPercent?: number;
  network?: { received: number; sent: number };
  // Summed over all backend processes, for the report period.
  traffic?: BackendCounters;
  // Within the alert window.
  recentLogErrors?: LogErrors | null;
  recentFailedLogins?: number;
  // Days until each disk (by path) is full.
  diskFullInDays?: Map<string, number>;
  certificates?: Certificate[];
  updates?: Updates;
};

// `key` names the problem across checks; the text may change.
export type Problem = { key: string; text: string };

export function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const number = (value: number) => value.toLocaleString("en-US");

const percent = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

export function bytes(value: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  const sign = value < 0 ? "−" : "";
  let rest = Math.abs(value);
  let unit = 0;

  while (rest >= 1024 && unit < units.length - 1) {
    rest /= 1024;
    unit++;
  }

  const shown = unit === 0 || rest >= 100 ? Math.round(rest) : Math.round(rest * 10) / 10;

  return `${sign}${shown} ${units[unit]}`;
}

const signedBytes = (value: number) => (value >= 0 ? `+${bytes(value)}` : bytes(value));

// 1234567 → "1.2M".
export function short(value: number) {
  if (value >= 1e6) {
    return `${Math.round(value / 1e5) / 10}M`;
  }

  if (value >= 1e4) {
    return `${Math.round(value / 1e3)}K`;
  }

  return number(value);
}

export function duration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }

  return `${minutes}m`;
}

export function time(date: Date) {
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

// ▲4 / ▼8 against the previous value; nothing when the same or unknown.
function change(now: number, before: number | undefined) {
  if (before === undefined || now === before) {
    return "";
  }

  return now > before ? ` ▲${number(now - before)}` : ` ▼${number(before - now)}`;
}

function bar(fraction: number, width = 10) {
  const filled = Math.min(width, Math.max(0, Math.round(fraction * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

const used = (free: number, total: number) => percent(total - free, total);

// "127.0.0.1:3000" of "http://127.0.0.1:3000".
const host = (url: string) => url.replace(/^https?:\/\//, "");

const label = (disk: { labels: string[] }) => disk.labels.join(", ");

export function problems(snapshot: Snapshot, limits: Thresholds, extras: Extras = {}): Problem[] {
  const found: Problem[] = [];

  for (const check of snapshot.backends) {
    if (!check.ok) {
      found.push({ key: `backend ${check.url}`, text: `Backend ${host(check.url)} is down: ${check.error}` });
    } else if ((check.latencyMs ?? 0) > limits.slowResponseMs) {
      found.push({ key: `slow ${check.url}`, text: `Backend ${host(check.url)} is slow: ${check.latencyMs} ms` });
    }
  }

  if (!snapshot.database.ok) {
    found.push({ key: "database", text: `Database error: ${snapshot.database.error}` });
  } else if (snapshot.database.counts) {
    const { connections, maxConnections } = snapshot.database.counts;

    if (percent(connections, maxConnections) >= 90) {
      found.push({ key: "connections", text: `Postgres connections: ${connections} of ${maxConnections}` });
    }
  }

  for (const unit of snapshot.units ?? []) {
    if (unit.problem) {
      found.push({ key: `unit ${unit.name}`, text: `Service ${unit.name} is ${unit.active} (${unit.sub})` });
    }
  }

  for (const disk of snapshot.disks) {
    const fullIn = extras.diskFullInDays?.get(disk.path);

    if (percent(disk.free, disk.total) < limits.diskMinFreePercent || disk.free < limits.diskMinFreeBytes) {
      found.push({
        key: `disk ${disk.path}`,
        text: `Low disk space (${label(disk)}): ${bytes(disk.free)} free of ${bytes(disk.total)}`,
      });
    } else if (fullIn !== undefined && fullIn < limits.diskFullAlertDays) {
      found.push({
        key: `disk forecast ${disk.path}`,
        text: `Disk (${label(disk)}) will be full in ~${Math.max(1, Math.round(fullIn))} days at this rate (${bytes(disk.free)} free)`,
      });
    }
  }

  const { available, total } = snapshot.memory;

  if (percent(available, total) < limits.memoryMinFreePercent) {
    found.push({ key: "memory", text: `Low memory: ${bytes(available)} free of ${bytes(total)}` });
  }

  if (snapshot.backup) {
    const hours = (snapshot.at.getTime() - snapshot.backup.at.getTime()) / 3_600_000;

    if (hours > limits.backupMaxAgeHours) {
      found.push({ key: "backup", text: `Last backup was ${Math.floor(hours)}h ago` });
    }
  }

  const logs = extras.recentLogErrors;

  if (logs && logs.count >= limits.logErrorsAlert) {
    found.push({
      key: "log errors",
      text: `Backend logged ${logs.count} errors recently${logs.top ? `, mostly "${logs.top}"` : ""}`,
    });
  }

  if ((extras.recentFailedLogins ?? 0) >= limits.failedLoginsAlert) {
    found.push({
      key: "failed logins",
      text: `${extras.recentFailedLogins} failed logins recently: someone may be guessing passwords`,
    });
  }

  for (const cert of extras.certificates ?? []) {
    const days = cert.expiresAt ? (cert.expiresAt.getTime() - snapshot.at.getTime()) / 86_400_000 : undefined;

    if (cert.error) {
      found.push({ key: `tls ${cert.host}`, text: `SSL certificate of ${cert.host}: ${cert.error}` });
    } else if (days !== undefined && days < limits.certificateMinDays) {
      found.push({
        key: `tls ${cert.host}`,
        text: `SSL certificate of ${cert.host} expires in ${Math.max(0, Math.floor(days))} days (not renewed?)`,
      });
    }
  }

  return found;
}

export function problemsText(list: Problem[]) {
  if (list.length === 0) {
    return "✅ All good";
  }

  return [`🔴 <b>${list.length === 1 ? "1 problem" : `${list.length} problems`}</b>`, ...list.map((p) => `• ${escapeHtml(p.text)}`)].join("\n");
}

// Totals of all processes: they all see the same online users.
function backendTotals(snapshot: Snapshot) {
  return snapshot.backends.find((check) => check.stats)?.stats;
}

function statsError(snapshot: Snapshot) {
  const up = snapshot.backends.find((check) => check.ok);
  return up ? up.statsError ?? "no data" : "backend is down";
}

export function report(snapshot: Snapshot, limits: Thresholds, recentMinutes: number, extras: Extras = {}) {
  const found = problems(snapshot, limits, extras);
  const counts: Counts | undefined = snapshot.database.ok ? snapshot.database.counts : undefined;
  const stats = backendTotals(snapshot);
  const previous = extras.previous;
  const mainDisk = snapshot.disks[0];

  // --- summary: what shows in the notification ---

  const status = found.length === 0 ? "🟢 <b>Ostrich</b> · all good" : `🔴 <b>Ostrich</b> · ${found.length === 1 ? "1 problem" : `${found.length} problems`}`;
  const summary = [`${status} · ${time(snapshot.at)}`];

  for (const problem of found) {
    summary.push(`• ${escapeHtml(problem.text)}`);
  }

  const people = [
    counts ? `${number(counts.users)} users${change(counts.users, previous?.users).replace("▲", "+").replace("▼", "−")}` : null,
    stats ? `${number(stats.online)} online${change(stats.online, previous?.online)}` : null,
  ].filter(Boolean);

  if (people.length > 0) {
    summary.push(`👥 ${people.join(" · ")}`);
  }

  if (counts) {
    summary.push(`💬 ${number(counts.messagesRecent)} msgs / ${recentMinutes} min · ${number(counts.messages24h)} / 24h`);
  }

  const server = [
    mainDisk ? `disk ${used(mainDisk.free, mainDisk.total)}%` : null,
    `ram ${used(snapshot.memory.available, snapshot.memory.total)}%`,
    extras.cpuPercent !== undefined ? `cpu ${extras.cpuPercent}%` : `load ${snapshot.load[0].toFixed(2)}`,
  ].filter(Boolean);
  summary.push(`💽 ${server.join(" · ")}`);

  // --- details, in an expandable quote ---

  const details: string[] = ["<b>Users</b>"];

  if (counts) {
    details.push(`Total: ${number(counts.users)}${change(counts.users, previous?.users)}`);
    details.push(`New in 24h: ${number(counts.newUsers24h)}`);
  }

  if (stats) {
    const peak = extras.peak ? ` · peak ${number(extras.peak.online)} at ${time(extras.peak.at)}` : "";
    details.push(`Online: ${number(stats.online)}${change(stats.online, previous?.online)}${peak}`);
    details.push(`Connections: ${number(stats.sockets)}`);

    if (stats.active24h !== undefined) {
      details.push(`Active in 24h: ${number(stats.active24h)}`);
    }
  } else {
    details.push(`Online: — (${escapeHtml(statsError(snapshot))})`);
  }

  details.push("", "<b>Activity</b>");

  if (counts) {
    details.push(
      `Messages: ${number(counts.messagesRecent)} / ${recentMinutes} min${change(counts.messagesRecent, previous?.messagesRecent)} · ${number(counts.messages24h)} / 24h`,
    );
  }

  if (extras.traffic) {
    const { requests, serverErrors, rateLimited, failedLogins } = extras.traffic;
    details.push(`Requests: ${number(requests)} / ${recentMinutes} min · 5xx: ${number(serverErrors)} · 429: ${number(rateLimited)}`);
    details.push(`Failed logins: ${number(failedLogins)} / ${recentMinutes} min`);
  }

  const logs = snapshot.logErrors;

  if (logs) {
    const top = logs.top ? ` · mostly "${escapeHtml(logs.top)}"` : "";
    details.push(`Log errors: ${number(logs.count)} / ${recentMinutes} min${top}`);
  }

  if (counts) {
    details.push(`Groups: ${number(counts.groups)} · sessions: ${number(counts.sessions)}`);
    details.push(`Database: ${bytes(counts.databaseBytes)} · files: ${bytes(counts.attachmentBytes)} (${number(counts.attachments)})`);
  }

  details.push("", "<b>Server</b>");

  const cpu = extras.cpuPercent !== undefined ? `CPU ${extras.cpuPercent}% · ` : "";
  details.push(`${cpu}load ${snapshot.load.map((value) => value.toFixed(2)).join(" ")} · ${snapshot.cpus} cores`);

  const { available, total, swapFree, swapTotal } = snapshot.memory;
  details.push(`RAM ${bar((total - available) / total)} ${used(available, total)}% · ${bytes(available)} free`);

  if (swapTotal > 0) {
    details.push(`Swap ${used(swapFree, swapTotal)}% of ${bytes(swapTotal)}`);
  }

  for (const disk of snapshot.disks) {
    const fullIn = extras.diskFullInDays?.get(disk.path);
    const forecast = fullIn !== undefined && fullIn < 365 ? ` · full in ~${Math.max(1, Math.round(fullIn))}d` : "";
    details.push(
      `Disk (${label(disk)}) ${bar((disk.total - disk.free) / disk.total)} ${used(disk.free, disk.total)}% · ${bytes(disk.free)} free${forecast}`,
    );
  }

  if (extras.network) {
    details.push(`Network ↓ ${bytes(extras.network.received)} ↑ ${bytes(extras.network.sent)} / ${recentMinutes} min`);
  }

  const system = [`Uptime ${duration(snapshot.uptimeSeconds)}`];

  if (extras.updates?.pending) {
    system.push(`${extras.updates.pending} updates${extras.updates.security ? ` (${extras.updates.security} security)` : ""}`);
  }

  if (extras.updates?.rebootRequired) {
    system.push("reboot required");
  }

  details.push(system.join(" · "));

  details.push("", "<b>Backend</b>");

  for (const check of snapshot.backends) {
    if (!check.ok) {
      details.push(`❌ ${escapeHtml(host(check.url))} · ${escapeHtml(check.error ?? "down")}`);
      continue;
    }

    const parts = [`✅ ${escapeHtml(host(check.url))}`, `${check.latencyMs} ms`];

    if (check.stats) {
      parts.push(`${bytes(check.stats.process.rssBytes)} RAM`, `up ${duration(check.stats.process.uptimeSeconds)}`);
    }

    details.push(parts.join(" · "));
  }

  if (stats && stats.processes > 1) {
    details.push(`Processes: ${stats.processes}`);
  }

  if (counts) {
    details.push(`Postgres connections: ${counts.connections} / ${counts.maxConnections}`);
  }

  details.push("", "<b>Services</b>");

  const units = (snapshot.units ?? []).map((unit) => {
    const icon = unit.problem ? "❌" : unit.active === "active" ? "✅" : "⚪";
    const restarts = unit.restarts > 0 ? ` (${unit.restarts} restarts)` : "";
    return `${icon} ${escapeHtml(unit.name)}${restarts}`;
  });

  if (units.length > 0) {
    details.push(units.join(" · "));
  }

  if (snapshot.backup) {
    const ago = (snapshot.at.getTime() - snapshot.backup.at.getTime()) / 1000;
    details.push(`💾 Backup ${duration(ago)} ago · ${bytes(snapshot.backup.size)}`);
  } else if (snapshot.backup === null) {
    details.push("💾 No backups yet");
  }

  for (const cert of extras.certificates ?? []) {
    if (cert.expiresAt && !cert.error) {
      const days = Math.floor((cert.expiresAt.getTime() - snapshot.at.getTime()) / 86_400_000);
      details.push(`🔒 ${escapeHtml(cert.host)} · SSL ${days}d left`);
    } else {
      details.push(`🔓 ${escapeHtml(cert.host)} · ${escapeHtml(cert.error ?? "no certificate")}`);
    }
  }

  return `${summary.join("\n")}\n<blockquote expandable>${details.join("\n")}</blockquote>`;
}

// --- daily summary ---

export type DaySummary = {
  date: Date;
  newUsers: number;
  newUsersBefore?: number;
  messages: number;
  messagesBefore?: number;
  peak?: { online: number; at: Date };
  active?: number;
  totalUsers?: number;
  traffic?: BackendCounters;
  logErrors: LogErrors | null;
  // systemd restarts of the backend after a crash.
  crashes: number;
  // Change over the day (undefined: not known since when).
  databaseBytes?: number;
  databaseChange?: number;
  attachmentBytes?: number;
  attachmentChange?: number;
  disks: { label: string; free: number; change?: number; fullInDays?: number }[];
  updates?: Updates;
  backup?: { at: Date; size: number } | null;
};

function percentChange(now: number, before: number | undefined) {
  if (before === undefined) {
    return "";
  }

  if (before === 0) {
    return now === 0 ? " (same as the day before)" : " (none the day before)";
  }

  const change = Math.round(((now - before) / before) * 100);

  return change === 0 ? " (same as the day before)" : ` (${change > 0 ? "▲" : "▼"}${Math.abs(change)}% vs the day before)`;
}

export function dailySummary(day: DaySummary) {
  const date = day.date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  const lines = [`📅 <b>Daily summary</b> · ${date}`, ""];

  lines.push(`👥 New users: ${number(day.newUsers)}${percentChange(day.newUsers, day.newUsersBefore)}`);

  if (day.totalUsers !== undefined) {
    lines.push(`👤 Total users: ${number(day.totalUsers)}${day.active !== undefined ? ` · active: ${number(day.active)}` : ""}`);
  }

  if (day.peak) {
    lines.push(`📈 Peak online: ${number(day.peak.online)} at ${time(day.peak.at)}`);
  }

  lines.push(`💬 Messages: ${number(day.messages)}${percentChange(day.messages, day.messagesBefore)}`);

  if (day.traffic) {
    lines.push(
      `🌐 Requests: ${short(day.traffic.requests)} · 5xx: ${number(day.traffic.serverErrors)} · 429: ${number(day.traffic.rateLimited)}`,
    );
    lines.push(`🔑 Failed logins: ${number(day.traffic.failedLogins)}`);
  }

  const trouble = [`⚠️ Log errors: ${day.logErrors ? number(day.logErrors.count) : "—"}`, `crashes: ${day.crashes}`];
  lines.push(trouble.join(" · "));

  if (day.logErrors?.top) {
    lines.push(`   mostly "${escapeHtml(day.logErrors.top)}"`);
  }

  if (day.databaseBytes !== undefined) {
    const db = `🗄 Database: ${bytes(day.databaseBytes)}${day.databaseChange !== undefined ? ` (${signedBytes(day.databaseChange)})` : ""}`;
    const files =
      day.attachmentBytes !== undefined
        ? ` · files: ${bytes(day.attachmentBytes)}${day.attachmentChange !== undefined ? ` (${signedBytes(day.attachmentChange)})` : ""}`
        : "";
    lines.push(db + files);
  }

  for (const disk of day.disks) {
    const change = disk.change !== undefined ? ` (${signedBytes(-disk.change)} used)` : "";
    const forecast = disk.fullInDays !== undefined && disk.fullInDays < 365 ? ` · full in ~${Math.max(1, Math.round(disk.fullInDays))}d` : "";
    lines.push(`💽 Disk (${disk.label}): ${bytes(disk.free)} free${change}${forecast}`);
  }

  if (day.updates) {
    const parts = [];

    if (day.updates.pending !== undefined) {
      parts.push(day.updates.pending === 0 ? "up to date" : `${day.updates.pending} updates (${day.updates.security ?? 0} security)`);
    }

    if (day.updates.rebootRequired) {
      parts.push("reboot required");
    }

    if (parts.length > 0) {
      lines.push(`🧩 System: ${parts.join(" · ")}`);
    }
  }

  if (day.backup) {
    lines.push(`💾 Last backup: ${time(day.backup.at)} · ${bytes(day.backup.size)}`);
  } else if (day.backup === null) {
    lines.push("💾 No backups");
  }

  return lines.join("\n");
}
