import type { Snapshot } from "./stats.js";

// What the monitoring says about a snapshot: its problems and the report,
// as Telegram HTML.

export type Thresholds = {
  // A disk is low when less than either is free.
  diskMinFreePercent: number;
  diskMinFreeBytes: number;
  memoryMinFreePercent: number;
  // Older is a problem (only once there are backups).
  backupMaxAgeHours: number;
};

// `key` names the problem across checks; the text may change.
export type Problem = { key: string; text: string };

export function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const number = (value: number) => value.toLocaleString("ru-RU");

const percent = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

export function bytes(value: number) {
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }

  const shown = unit === 0 || value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;

  return `${shown.toLocaleString("ru-RU")} ${units[unit]}`;
}

export function duration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days} д ${hours % 24} ч`;
  }

  if (hours > 0) {
    return `${hours} ч ${minutes % 60} мин`;
  }

  return `${minutes} мин`;
}

function time(date: Date) {
  return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

// "127.0.0.1:3000" of "http://127.0.0.1:3000".
const host = (url: string) => url.replace(/^https?:\/\//, "");

export function problems(snapshot: Snapshot, limits: Thresholds): Problem[] {
  const found: Problem[] = [];

  for (const check of snapshot.backends) {
    if (!check.ok) {
      found.push({ key: `backend ${check.url}`, text: `Бэкенд ${host(check.url)} не отвечает: ${check.error}` });
    }
  }

  if (!snapshot.database.ok) {
    found.push({ key: "database", text: `Ошибка базы данных: ${snapshot.database.error}` });
  }

  for (const unit of snapshot.units ?? []) {
    if (unit.problem) {
      found.push({ key: `unit ${unit.name}`, text: `Сервис ${unit.name}: ${unit.active} (${unit.sub})` });
    }
  }

  for (const disk of snapshot.disks) {
    if (percent(disk.free, disk.total) < limits.diskMinFreePercent || disk.free < limits.diskMinFreeBytes) {
      found.push({
        key: `disk ${disk.path}`,
        text: `Мало места (${disk.labels.join(", ")}): свободно ${bytes(disk.free)} из ${bytes(disk.total)} (${percent(disk.free, disk.total)}%)`,
      });
    }
  }

  const { available, total } = snapshot.memory;

  if (percent(available, total) < limits.memoryMinFreePercent) {
    found.push({
      key: "memory",
      text: `Мало памяти: свободно ${bytes(available)} из ${bytes(total)} (${percent(available, total)}%)`,
    });
  }

  if (snapshot.backup) {
    const hours = (snapshot.at.getTime() - snapshot.backup.at.getTime()) / 3_600_000;

    if (hours > limits.backupMaxAgeHours) {
      found.push({ key: "backup", text: `Последний бэкап был ${Math.floor(hours)} ч назад` });
    }
  }

  return found;
}

export function problemsText(list: Problem[]) {
  if (list.length === 0) {
    return "✅ Всё в порядке";
  }

  return ["⚠️ <b>Проблемы</b>", ...list.map((problem) => `• ${escapeHtml(problem.text)}`)].join("\n");
}

export function report(snapshot: Snapshot, limits: Thresholds, recentMinutes: number) {
  const lines: string[] = [`📊 <b>Ostrich</b> · ${time(snapshot.at)}`];
  const found = problems(snapshot, limits);

  if (found.length > 0) {
    lines.push("", problemsText(found));
  }

  const counts = snapshot.database.ok ? snapshot.database.counts : undefined;
  const stats = snapshot.backendStats && !("error" in snapshot.backendStats) ? snapshot.backendStats : null;
  const statsError = snapshot.backendStats && "error" in snapshot.backendStats ? snapshot.backendStats.error : null;

  lines.push("", "<b>Пользователи</b>");

  if (counts) {
    lines.push(`Всего: ${number(counts.users)} (+${number(counts.newUsers24h)} за сутки)`);
  }

  if (stats) {
    lines.push(`Онлайн: ${number(stats.online)} (подключений: ${number(stats.sockets)})`);
    lines.push(`Активных за сутки: ${number(stats.active24h)}`);
  } else {
    lines.push(`Онлайн: — (${escapeHtml(statsError ?? "бэкенд не отвечает")})`);
  }

  if (counts) {
    lines.push(
      "",
      "<b>Активность</b>",
      `Сообщений: ${number(counts.messagesRecent)} за ${recentMinutes} мин · ${number(counts.messages24h)} за сутки`,
      `Групп: ${number(counts.groups)} · сессий: ${number(counts.sessions)}`,
      `База: ${bytes(counts.databaseBytes)} · вложения: ${bytes(counts.attachmentBytes)} (${number(counts.attachments)} файлов)`,
    );
  }

  lines.push("", "<b>Сервер</b>");

  for (const disk of snapshot.disks) {
    lines.push(
      `Диск (${disk.labels.join(", ")}): свободно ${bytes(disk.free)} из ${bytes(disk.total)} (${percent(disk.free, disk.total)}%)`,
    );
  }

  const { available, total } = snapshot.memory;
  lines.push(`Память: свободно ${bytes(available)} из ${bytes(total)} (${percent(available, total)}%)`);
  lines.push(`Нагрузка: ${snapshot.load.map((value) => value.toFixed(2)).join(" ")} (ядер: ${snapshot.cpus})`);
  lines.push(`Аптайм: ${duration(snapshot.uptimeSeconds)}`);

  lines.push("", "<b>Сервисы</b>");

  for (const check of snapshot.backends) {
    lines.push(`${check.ok ? "✅" : "❌"} бэкенд ${escapeHtml(host(check.url))}`);
  }

  if (stats && stats.processes > 1) {
    lines.push(`Процессов бэкенда: ${stats.processes}`);
  }

  for (const unit of snapshot.units ?? []) {
    lines.push(`${unit.problem ? "❌" : unit.active === "active" ? "✅" : "⚪"} ${escapeHtml(unit.name)}`);
  }

  if (snapshot.backup) {
    const ago = (snapshot.at.getTime() - snapshot.backup.at.getTime()) / 1000;
    lines.push(`Бэкап: ${duration(ago)} назад, ${bytes(snapshot.backup.size)}`);
  } else if (snapshot.backup === null) {
    lines.push("Бэкап: ещё не было");
  }

  return lines.join("\n");
}
