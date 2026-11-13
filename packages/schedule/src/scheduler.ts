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
  /** Also run once when the scheduler starts (on every instance: not coordinated by `lock`). */
  runOnStart?: boolean;
  /**
   * Set `false` to run this job on every instance even though the scheduler has a `lock` (e.g. a
   * per-process cache refresh). Default true: scheduled runs go through the scheduler's `lock`.
   */
  lock?: boolean;
  /** How long this job's run lock is held, in ms. Default: the scheduler's `lockTtlMs`. */
  lockTtlMs?: number;
}

/**
 * Lets one instance out of several take a scheduled run. `acquire` must return true for exactly one
 * caller per key until `ttlMs` has passed. `createRedisJobLock(client)` is one backed by Redis.
 */
export interface JobLock {
  acquire(key: string, ttlMs: number): boolean | Promise<boolean>;
}

/**
 * Passed to `onError` when `lock.acquire` throws or rejects (e.g. Redis is down). That scheduled run was
 * skipped on this instance; `cause` is the lock's error.
 */
export class JobLockError extends Error {
  constructor(readonly job: string, cause: unknown) {
    super(`Could not take the lock for job "${job}"; the scheduled run was skipped`, { cause });
    this.name = 'JobLockError';
  }
}

export interface JobInfo {
  name: string;
  expression: string;
  timeZone: string;
  /** Whether the handler is running on this instance. */
  running: boolean;
  nextRun: Date | undefined;
  /** When the handler last started on this instance (runs another instance took through `lock` are not counted). */
  lastRun: Date | undefined;
  lastError: unknown;
}

export interface SchedulerOptions {
  /** Default IANA time zone. Default: the process's local zone. */
  timeZone?: string;
  /** Called when a job throws, or with a `JobLockError` when `lock` fails (default: log it). */
  onError?: (error: unknown, job: string) => void;
  /** How long `stop()` waits for running jobs, in ms. Default 30000. */
  shutdownTimeoutMs?: number;
  /**
   * Let the process exit while only timers are pending. Default false: a worker process that only
   * runs jobs stays alive, as with an HTTP server.
   */
  unref?: boolean;
  /**
   * Runs each scheduled run on one instance only. Before a scheduled run, every instance calls
   * `lock.acquire('<job name>:<scheduled time in ms>', lockTtlMs)`; the one that gets it runs the job
   * and the others skip that run. The lock is not released after the run (it expires), so an instance
   * whose clock lags cannot run the same scheduled time again. Not coordinated: `run(name)`,
   * `runOnStart`, and jobs with `lock: false`. When `acquire` fails, the run is skipped on this instance
   * and `onError` gets a `JobLockError`. An instance still running the previous run (`overlap: 'skip'`)
   * does not compete, so a long run on one instance can overlap the next run on another.
   */
  lock?: JobLock;
  /**
   * How long a scheduled run's lock is held, in ms. Default 60000. It must be longer than the clock
   * difference between instances (plus timer delays); a lagging instance reaching the same scheduled
   * time after the lock expired would run it again.
   */
  lockTtlMs?: number;
}

interface Job {
  name: string;
  expression: string;
  timeZone: string;
  schedule: CronSchedule;
  handler: () => unknown | Promise<unknown>;
  options: JobOptions;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Runs in progress, including scheduled runs still waiting for the lock (overlap check, `stop()`). */
  running: Set<Promise<void>>;
  /** Handlers executing now (`list().running`). */
  active: number;
  nextRun: Date | undefined;
  lastRun: Date | undefined;
  lastError: unknown;
}

// setTimeout clamps delays above 2^31-1 ms; longer waits re-arm in steps.
const MAX_DELAY = 2_147_483_647;
const DEFAULT_LOCK_TTL_MS = 60_000;

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
    assertLockTtl(options.lockTtlMs, 'Scheduler');
  }

  /** Adds a job (validates the expression immediately). Jobs added after `start()` are scheduled at once. */
  cron(name: string, expression: string, handler: () => unknown | Promise<unknown>, options: JobOptions = {}) {
    if (this.jobs.has(name)) {
      throw new Error(`A job named "${name}" already exists`);
    }
    assertLockTtl(options.lockTtlMs, `Job "${name}"`);
    const timeZone = options.timeZone ?? this.timeZone;
    const job: Job = {
      name, expression, timeZone, schedule: parseCron(expression, timeZone), handler, options,
      timer: undefined, running: new Set(), active: 0, nextRun: undefined, lastRun: undefined, lastError: undefined,
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

  /** Runs a job now (outside its schedule and without the `lock`), e.g. from a test or an admin endpoint. */
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
      running: job.active > 0,
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
        void this.execute(job, false, nextRun);
      }, Math.min(Math.max(delay, 0), MAX_DELAY));
      if (this.options.unref) {
        (job.timer as { unref?: () => void }).unref?.();
      }
    };
    wait();
  }

  /** `scheduledAt` is set for timer runs only: those are the ones the `lock` coordinates. */
  private execute(job: Job, manual = false, scheduledAt?: Date): Promise<void> {
    if (!manual && job.running.size > 0 && (job.options.overlap ?? 'skip') === 'skip') {
      return Promise.resolve();
    }
    const lock = job.options.lock === false ? undefined : this.options.lock;
    const run = lock && scheduledAt ? this.runLocked(job, lock, scheduledAt) : this.runHandler(job, manual);
    const tracked = run.catch(() => undefined).finally(() => job.running.delete(tracked));
    job.running.add(tracked);
    return run;
  }

  private async runLocked(job: Job, lock: JobLock, scheduledAt: Date) {
    let acquired: boolean;
    try {
      // Every instance derives the same key for the same scheduled time.
      acquired = await lock.acquire(`${job.name}:${scheduledAt.getTime()}`, job.options.lockTtlMs ?? this.options.lockTtlMs ?? DEFAULT_LOCK_TTL_MS);
    } catch (cause) {
      // Fail closed: without the lock this instance cannot know whether another one runs it.
      const error = new JobLockError(job.name, cause);
      if (this.options.onError) {
        this.options.onError(error, job.name);
      } else {
        console.error(`[kivin] ${error.message}`, cause);
      }
      return;
    }
    if (acquired) {
      await this.runHandler(job, false);
    }
  }

  private async runHandler(job: Job, manual: boolean) {
    job.lastRun = new Date();
    job.active += 1;
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
    } finally {
      job.active -= 1;
    }
  }
}

function assertLockTtl(ttlMs: number | undefined, owner: string) {
  if (ttlMs !== undefined && !(ttlMs > 0 && Number.isFinite(ttlMs))) {
    throw new TypeError(`${owner}: lockTtlMs must be a positive number of milliseconds`);
  }
}

/** A scheduler with `cron(...)` jobs, for a `useFactory` / `useValue` provider. */
export function createScheduler(options: SchedulerOptions = {}) {
  return new Scheduler(options);
}
