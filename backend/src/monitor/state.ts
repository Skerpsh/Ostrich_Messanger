import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BackendCounters } from "./stats.js";

// What the monitoring remembers across restarts (a deploy restarts it):
// the day's figures for the daily summary, and disk usage for the forecast.

export type State = {
  // The local date ("2026-10-08") the day's figures are for.
  day: string;
  peak?: { online: number; at: string };
  traffic: BackendCounters;
  crashes: number;
  // At the start of the day (or when first seen that day).
  dayStart?: { databaseBytes?: number; attachmentBytes?: number; diskFree: Record<string, number> };
  // Of the previous report, for ▲/▼.
  previous?: { users: number; online: number; messagesRecent: number };
  // Used bytes of each disk (by path), about hourly, for a week.
  samples: { at: number; used: Record<string, number> }[];
};

export const emptyCounters = (): BackendCounters => ({ requests: 0, serverErrors: 0, rateLimited: 0, failedLogins: 0 });

export function localDay(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function newDay(date: Date, keep?: State): State {
  return { day: localDay(date), traffic: emptyCounters(), crashes: 0, previous: keep?.previous, samples: keep?.samples ?? [] };
}

export async function loadState(file: string): Promise<State> {
  try {
    const state = JSON.parse(await readFile(file, "utf8")) as State;

    if (typeof state.day === "string" && Array.isArray(state.samples) && state.traffic) {
      return state;
    }
  } catch {
    // None yet, or unreadable: start over.
  }

  return newDay(new Date());
}

let warned = false;

// Written whole to a temporary file first: a crash never leaves half a file.
export async function saveState(file: string, state: State) {
  try {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(`${file}.tmp`, JSON.stringify(state));
    await rename(`${file}.tmp`, file);
  } catch (error) {
    if (!warned) {
      warned = true;
      console.warn(`monitor: cannot save ${file}, the day's figures are lost on restart:`, error);
    }
  }
}

const WEEK_MS = 7 * 86_400_000;

export function addSample(state: State, at: Date, used: Record<string, number>) {
  state.samples.push({ at: at.getTime(), used });
  state.samples = state.samples.filter((sample) => sample.at > at.getTime() - WEEK_MS);
}

// Days until the disk is full at the rate of the last week (least squares
// over the samples), or undefined when it is not filling up or there is
// too little history (less than half a day).
export function daysUntilFull(state: State, diskPath: string, free: number) {
  const points = state.samples
    .filter((sample) => sample.used[diskPath] !== undefined)
    .map((sample) => [sample.at / 86_400_000, sample.used[diskPath]] as const);

  if (points.length < 3 || points[points.length - 1][0] - points[0][0] < 0.5) {
    return undefined;
  }

  const n = points.length;
  const meanX = points.reduce((sum, [x]) => sum + x, 0) / n;
  const meanY = points.reduce((sum, [, y]) => sum + y, 0) / n;
  let covariance = 0;
  let variance = 0;

  for (const [x, y] of points) {
    covariance += (x - meanX) * (y - meanY);
    variance += (x - meanX) ** 2;
  }

  // Bytes per day.
  const rate = variance > 0 ? covariance / variance : 0;

  return rate > 0 ? free / rate : undefined;
}
