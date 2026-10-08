import type { Problem } from "./report.js";

// Turns the problems of each check into alerts: a problem is raised once it
// has been seen in `after` checks in a row (a restart during a deploy is
// not an alert), and cleared once it is gone.
export class AlertTracker {
  private seen = new Map<string, { count: number; text: string; raised: boolean }>();

  constructor(private after: number) {}

  update(found: Problem[]) {
    const raised: Problem[] = [];
    const cleared: Problem[] = [];
    const keys = new Set(found.map((problem) => problem.key));

    for (const problem of found) {
      const entry = this.seen.get(problem.key) ?? { count: 0, text: problem.text, raised: false };
      entry.count++;
      entry.text = problem.text;

      if (!entry.raised && entry.count >= this.after) {
        entry.raised = true;
        raised.push(problem);
      }

      this.seen.set(problem.key, entry);
    }

    for (const [key, entry] of this.seen) {
      if (!keys.has(key)) {
        if (entry.raised) {
          cleared.push({ key, text: entry.text });
        }

        this.seen.delete(key);
      }
    }

    return { raised, cleared };
  }
}
