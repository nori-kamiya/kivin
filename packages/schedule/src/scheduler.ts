// In-process job scheduler driven by cron expressions, tied to the application lifecycle.
import { localTimeZone, parseCron, type CronSchedule } from './cron';

export interface JobOptions {
  /** IANA time zone for this job (default: the scheduler's). */
  timeZone?: string;
  /**
   * What to do when a run is due while the previous one is still running: `'skip'` (default) drops
   * the new run, `'allow'` starts it anyway.
   */
  overlap?: 'skip' | 'allow';
  /** Also run once when the scheduler starts. */
  runOnStart?: boolean;
}

export interface JobInfo {
  name: string;
  expression: string;
  timeZone: string;
  running: boolean;
  nextRun: Date | undefined;
  lastRun: Date | undefined;
  lastError: unknown;
}

export interface SchedulerOptions {
  /** Default IANA time zone. Default: the process's local zone. */
  timeZone?: string;
  /** Called when a job throws (default: log it). */
  onError?: (error: unknown, job: string) => void;
  /** How long `stop()` waits for running jobs, in ms. Default 30000. */
  shutdownTimeoutMs?: number;
  /**
   * Let the process exit while only timers are pending. Default false: a worker process that only
   * runs jobs stays alive, as with an HTTP server.
   */
  unref?: boolean;
}

interface Job {
  name: string;
  expression: string;
  timeZone: string;
  schedule: CronSchedule;
  handler: () => unknown | Promise<unknown>;
  options: JobOptions;
  timer: ReturnType<typeof setTimeout> | undefined;
  running: Set<Promise<void>>;
  nextRun: Date | undefined;
  lastRun: Date | undefined;
  lastError: unknown;
}

// setTimeout clamps delays above 2^31-1 ms; longer waits re-arm in steps.
const MAX_DELAY = 2_147_483_647;

/**
 * Cron jobs that start with the application and stop (waiting for running jobs) on shutdown.
 *
 * ```ts
 * @Injectable({ deps: [ReportService] })
 * export class Jobs extends Scheduler {
 *   constructor(reports: ReportService) {
 *     super({ timeZone: 'Asia/Tokyo' });
 *     this.cron('daily-report', '0 9 * * MON-FRI', () => reports.send());
 *   }
 * }
 * // providers: [Jobs]; `await app.init()` starts it (onApplicationBootstrap), app.close() stops it.
 * ```
 */
export class Scheduler {
  private readonly jobs = new Map<string, Job>();
  private started = false;
  private readonly timeZone: string;

  constructor(private readonly options: SchedulerOptions = {}) {
    this.timeZone = options.timeZone ?? localTimeZone();
  }

  /** Adds a job (validates the expression immediately). Jobs added after `start()` are scheduled at once. */
  cron(name: string, expression: string, handler: () => unknown | Promise<unknown>, options: JobOptions = {}) {
    if (this.jobs.has(name)) {
      throw new Error(`A job named "${name}" already exists`);
    }
    const timeZone = options.timeZone ?? this.timeZone;
    const job: Job = {
      name, expression, timeZone, schedule: parseCron(expression, timeZone), handler, options,
      timer: undefined, running: new Set(), nextRun: undefined, lastRun: undefined, lastError: undefined,
    };
    this.jobs.set(name, job);
    if (this.started) {
      this.arm(job);
      if (options.runOnStart) {
        void this.execute(job);
      }
    }
    return this;
  }

  /** Removes a job (a running instance finishes). */
  remove(name: string) {
    const job = this.jobs.get(name);
    if (job) {
      clearTimeout(job.timer);
      this.jobs.delete(name);
    }
    return job !== undefined;
  }

  /** Starts the timers. Called by the application on bootstrap; safe to call twice. */
  start() {
    if (this.started) {
      return;
    }
    this.started = true;
    for (const job of this.jobs.values()) {
      this.arm(job);
      if (job.options.runOnStart) {
        void this.execute(job);
      }
    }
  }

  /** Stops scheduling and waits (up to `shutdownTimeoutMs`) for running jobs. */
  async stop() {
    this.started = false;
    for (const job of this.jobs.values()) {
      clearTimeout(job.timer);
      job.timer = undefined;
      job.nextRun = undefined;
    }
    const running = [...this.jobs.values()].flatMap((job) => [...job.running]);
    if (running.length > 0) {
      await Promise.race([Promise.allSettled(running), Bun.sleep(this.options.shutdownTimeoutMs ?? 30_000)]);
    }
  }

  /** Runs a job now (outside its schedule), e.g. from a test or an admin endpoint. */
  async run(name: string) {
    const job = this.jobs.get(name);
    if (!job) {
      throw new Error(`Unknown job "${name}"`);
    }
    await this.execute(job, true);
  }

  list(): JobInfo[] {
    return [...this.jobs.values()].map((job) => ({
      name: job.name,
      expression: job.expression,
      timeZone: job.timeZone,
      running: job.running.size > 0,
      nextRun: job.nextRun,
      lastRun: job.lastRun,
      lastError: job.lastError,
    }));
  }

  /** Lifecycle hook: the scheduler starts once the application has bootstrapped. */
  onApplicationBootstrap() {
    this.start();
  }

  /** Lifecycle hook: `app.close()` stops the scheduler. */
  onApplicationShutdown() {
    return this.stop();
  }

  private arm(job: Job, from = new Date()) {
    clearTimeout(job.timer);
    const nextRun = job.schedule.next(from);
    job.nextRun = nextRun;
    if (!nextRun) {
      return;
    }
    const wait = () => {
      const delay = nextRun.getTime() - Date.now();
      job.timer = setTimeout(() => {
        if (!this.started || this.jobs.get(job.name) !== job) {
          return;
        }
        if (nextRun.getTime() - Date.now() > 0) {
          wait();
          return;
        }
        this.arm(job, nextRun);
        void this.execute(job);
      }, Math.min(Math.max(delay, 0), MAX_DELAY));
      if (this.options.unref) {
        (job.timer as { unref?: () => void }).unref?.();
      }
    };
    wait();
  }

  private execute(job: Job, manual = false): Promise<void> {
    if (!manual && job.running.size > 0 && (job.options.overlap ?? 'skip') === 'skip') {
      return Promise.resolve();
    }
    job.lastRun = new Date();
    const run = (async () => {
      try {
        await job.handler();
        job.lastError = undefined;
      } catch (error) {
        job.lastError = error;
        if (this.options.onError) {
          this.options.onError(error, job.name);
        } else {
          console.error(`[kivin] Job "${job.name}" failed`, error);
        }
        if (manual) {
          throw error;
        }
      }
    })();
    const tracked = run.catch(() => undefined).finally(() => job.running.delete(tracked));
    job.running.add(tracked);
    return run;
  }
}

/** A scheduler with `cron(...)` jobs, for a `useFactory` / `useValue` provider. */
export function createScheduler(options: SchedulerOptions = {}) {
  return new Scheduler(options);
}
