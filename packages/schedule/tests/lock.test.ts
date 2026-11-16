import { createRedisJobLock, createScheduler, JobLockError, type JobLock, type RedisCommandClient } from '@kivinjs/schedule';
import { describe, expect, spyOn, test } from 'bun:test';

const waitFor = async (condition: () => boolean, timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting');
    }
    await Bun.sleep(20);
  }
};

/** An in-process stand-in for a shared lock: the first caller of a key gets it until the TTL ends. */
const memoryLock = (options: { async?: boolean; delayMs?: number } = {}) => {
  const held = new Map<string, number>();
  const calls: Array<[key: string, ttlMs: number]> = [];
  const take = (key: string, ttlMs: number) => {
    const now = Date.now();
    if ((held.get(key) ?? 0) > now) {
      return false;
    }
    held.set(key, now + ttlMs);
    return true;
  };
  const lock: JobLock = {
    acquire(key, ttlMs) {
      calls.push([key, ttlMs]);
      if (options.delayMs !== undefined) {
        return Bun.sleep(options.delayMs).then(() => take(key, ttlMs));
      }
      return options.async ? Promise.resolve().then(() => take(key, ttlMs)) : take(key, ttlMs);
    },
  };
  return { lock, calls };
};

describe('Scheduler lock', () => {
  test('two schedulers sharing a lock run each scheduled time once; lock: false jobs run on both', async () => {
    const { lock, calls } = memoryLock({ async: true });
    const reports: string[] = [];
    const refreshes: Record<string, number> = { a: 0, b: 0 };
    const instance = (name: 'a' | 'b') => createScheduler({ timeZone: 'UTC', lock })
      .cron('report', '* * * * * *', () => {
        reports.push(name);
      })
      .cron('refresh', '* * * * * *', () => {
        refreshes[name]! += 1;
      }, { lock: false });
    const a = instance('a');
    const b = instance('b');
    a.start();
    b.start();
    await waitFor(() => reports.length >= 3 && refreshes.a! >= 3 && refreshes.b! >= 3, 6000);
    await Promise.all([a.stop(), b.stop()]);

    // Both instances ask for the same key per scheduled time: `<job name>:<scheduled time in ms>`.
    const keys = calls.map(([key]) => key);
    const distinct = new Set(keys);
    expect([...distinct].every((key) => /^report:\d+000$/.test(key))).toBe(true);
    expect(keys.length).toBeGreaterThan(distinct.size);
    expect(reports.length).toBe(distinct.size);
    expect(calls.every(([, ttlMs]) => ttlMs === 60_000)).toBe(true);
    // The instance that lost a scheduled time does not record it as its own run.
    for (const [scheduler, name] of [[a, 'a'], [b, 'b']] as const) {
      expect(scheduler.list().find((job) => job.name === 'report')!.lastRun === undefined).toBe(!reports.includes(name));
    }
  }, 10_000);

  test('when the lock fails the run is skipped and reported as a JobLockError; the job keeps its schedule', async () => {
    let attempts = 0;
    const failing: JobLock = {
      acquire() {
        attempts += 1;
        if (attempts % 2 === 1) {
          throw new Error('connection refused');
        }
        return Promise.reject(new Error('timeout'));
      },
    };
    const errors: Array<[unknown, string]> = [];
    let runs = 0;
    const reported = createScheduler({ timeZone: 'UTC', lock: failing, onError: (error, job) => errors.push([error, job]) });
    reported.cron('tick', '* * * * * *', () => {
      runs += 1;
    });

    const log = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const logged = createScheduler({ timeZone: 'UTC', lock: { acquire: () => Promise.reject(new Error('down')) } });
      logged.cron('quiet', '* * * * * *', () => {
        runs += 1;
      });
      reported.start();
      logged.start();
      await waitFor(() => errors.length >= 2 && log.mock.calls.length >= 1);
      await Promise.all([reported.stop(), logged.stop()]);
      expect(String(log.mock.calls[0]![0])).toBe('[kivin] Could not take the lock for job "quiet"; the scheduled run was skipped');
      expect((log.mock.calls[0]![1] as Error).message).toBe('down');
    } finally {
      log.mockRestore();
    }

    expect(runs).toBe(0);
    const [first, second] = errors as Array<[JobLockError, string]>;
    expect(first![1]).toBe('tick');
    expect(first![0]).toBeInstanceOf(JobLockError);
    expect(first![0].job).toBe('tick');
    expect((first![0].cause as Error).message).toBe('connection refused');
    expect((second![0].cause as Error).message).toBe('timeout');
    expect(reported.list()[0]).toMatchObject({ lastRun: undefined, lastError: undefined, running: false });
  });

  test('run(name), runOnStart and a lost scheduled time: only scheduled runs ask the lock', async () => {
    const calls: string[] = [];
    const neverMine: JobLock = {
      acquire: (key) => {
        calls.push(key);
        return false;
      },
    };
    const ran: string[] = [];
    const scheduler = createScheduler({ timeZone: 'UTC', lock: neverMine })
      .cron('warmup', '0 0 1 1 *', () => {
        ran.push('warmup');
      }, { runOnStart: true })
      .cron('report', '* * * * * *', () => {
        ran.push('report');
      });
    await scheduler.run('report');
    scheduler.start();
    await waitFor(() => calls.length >= 1 && ran.includes('warmup'));
    await scheduler.stop();
    expect(ran.sort()).toEqual(['report', 'warmup']);
    expect(calls.every((key) => key.startsWith('report:'))).toBe(true);
  });

  test('lock TTL: the scheduler default, lockTtlMs on the scheduler and on a job; invalid values throw', async () => {
    const { lock, calls } = memoryLock();
    const defaults = createScheduler({ timeZone: 'UTC', lock }).cron('default', '* * * * * *', () => undefined);
    const custom = createScheduler({ timeZone: 'UTC', lock, lockTtlMs: 5_000 })
      .cron('scheduler', '* * * * * *', () => undefined)
      .cron('job', '* * * * * *', () => undefined, { lockTtlMs: 1_234 });
    defaults.start();
    custom.start();
    await waitFor(() => ['default', 'scheduler', 'job'].every((name) => calls.some(([key]) => key.startsWith(`${name}:`))));
    await Promise.all([defaults.stop(), custom.stop()]);
    const ttlOf = (name: string) => calls.find(([key]) => key.startsWith(`${name}:`))![1];
    expect([ttlOf('default'), ttlOf('scheduler'), ttlOf('job')]).toEqual([60_000, 5_000, 1_234]);

    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createScheduler({ lockTtlMs: bad })).toThrow(TypeError);
      expect(() => createScheduler().cron('x', '* * * * *', () => undefined, { lockTtlMs: bad })).toThrow(/lockTtlMs/);
    }
  });

  test('a run waiting for the lock counts for overlap (later times skip) but not as running; stop() waits for it', async () => {
    const { lock, calls } = memoryLock({ delayMs: 1500 });
    let runs = 0;
    const scheduler = createScheduler({ timeZone: 'UTC', lock }).cron('slow-lock', '* * * * * *', () => {
      runs += 1;
    });
    scheduler.start();
    await waitFor(() => calls.length === 1);
    await Bun.sleep(1100);
    expect(calls).toHaveLength(1);
    expect(scheduler.list()[0]!.running).toBe(false);
    expect(runs).toBe(0);
    await scheduler.stop();
    expect(runs).toBe(1);
  });
});

/** Just enough of `SET key value NX PX ms` to check the command the lock sends. */
class FakeRedis implements RedisCommandClient {
  readonly commands: string[][] = [];
  private readonly values = new Map<string, string>();

  async send(command: string, args: string[]) {
    this.commands.push([command, ...args]);
    const [key = '', value = ''] = args;
    if (this.values.has(key)) {
      return null;
    }
    this.values.set(key, value);
    return 'OK';
  }
}

describe('createRedisJobLock', () => {
  test('SET <prefix><key> <owner> NX PX <ttl>: acquired only on OK', async () => {
    const redis = new FakeRedis();
    const first = createRedisJobLock(redis);
    const second = createRedisJobLock(redis, { prefix: 'app:jobs:' });
    expect(await first.acquire('report:1700000000000', 60_000)).toBe(true);
    expect(await first.acquire('report:1700000000000', 60_000)).toBe(false);
    expect(await second.acquire('report:1700000000000', 1500.5)).toBe(true);
    const [one, two, three] = redis.commands;
    expect(one).toEqual(['SET', 'kivin:job:report:1700000000000', one![2]!, 'NX', 'PX', '60000']);
    expect(two![2]).toBe(one![2]!);
    expect(three).toEqual(['SET', 'app:jobs:report:1700000000000', three![2]!, 'NX', 'PX', '1501']);
    expect(three![2]).not.toBe(one![2]!);
  });

  test('a client error rejects (the scheduler reports it and skips the run)', async () => {
    const lock = createRedisJobLock({ send: () => Promise.reject(new Error('ECONNREFUSED')) });
    await expect(Promise.resolve(lock.acquire('job:1', 1000))).rejects.toThrow('ECONNREFUSED');
  });
});
