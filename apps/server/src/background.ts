// A clock for the app's periodic work, kept apart from any timer so a host can
// drive it however it likes: setInterval in Node, a Durable Object alarm in
// workerd. tick() runs every job that is due and answers when to look again.

export type BackgroundJob = {
  name: string;
  /** Delay from the scheduler's start to the first run. */
  firstAfterMs: number;
  /** Delay between runs, or null for a job that runs once. */
  everyMs: number | null;
  run(): void | Promise<void>;
};

export function createBackground(jobs: readonly BackgroundJob[], startedAt: number) {
  const nextAt = new Map(jobs.map((job) => [job.name, startedAt + job.firstAfterMs] as const));
  const running = new Set<string>();
  return {
    /** Starts every due job without waiting for it, and never runs one twice at once. */
    tick(now: number): void {
      for (const job of jobs) {
        const due = nextAt.get(job.name);
        if (due === undefined || due > now || running.has(job.name)) continue;
        nextAt.set(job.name, job.everyMs === null ? Infinity : now + job.everyMs);
        running.add(job.name);
        Promise.resolve()
          .then(() => job.run())
          .catch((err) => console.error(`${job.name}:`, (err as Error).message))
          .finally(() => running.delete(job.name));
      }
    },
  };
}
