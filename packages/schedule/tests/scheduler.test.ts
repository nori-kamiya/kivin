import { createApp, defineApplication, defineModule } from '@kivinjs/core';
import { createScheduler, Scheduler } from '@kivinjs/schedule';
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

describe('Scheduler', () => {
  test('runs jobs on schedule, lists next runs, stops cleanly', async () => {
    const scheduler = createScheduler({ timeZone: 'UTC' });
    let runs = 0;
    scheduler.cron('tick', '* * * * * *', () => {
      runs += 1;
    });
    expect(scheduler.list()[0]).toMatchObject({ name: 'tick', expression: '* * * * * *', timeZone: 'UTC', running: false, nextRun: undefined });
    scheduler.start();
    expect(scheduler.list()[0]!.nextRun!.getTime()).toBeGreaterThan(Date.now());
    await waitFor(() => runs >= 2);
    await scheduler.stop();
    const after = runs;
    await Bun.sleep(1100);
    expect(runs).toBe(after);
    expect(scheduler.list()[0]!.nextRun).toBeUndefined();
  });

  test('overlap: a run still in progress makes the next one skip (default)', async () => {
    const scheduler = new Scheduler({ timeZone: 'UTC' });
    let started = 0;
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    scheduler.cron('slow', '* * * * * *', async () => {
      started += 1;
      await blocker;
    });
    scheduler.start();
    await waitFor(() => started === 1);
    await Bun.sleep(2100);
    expect(started).toBe(1);
    expect(scheduler.list()[0]!.running).toBe(true);
    release();
    await scheduler.stop();
  });

  test('errors are reported (onError, or logged) and the job keeps its schedule', async () => {
    const errors: Array<[string, string]> = [];
    const scheduler = createScheduler({ timeZone: 'UTC', onError: (error, job) => errors.push([job, (error as Error).message]) });
    let attempts = 0;
    scheduler.cron('flaky', '* * * * * *', () => {
      attempts += 1;
      throw new Error(`attempt ${attempts}`);
    });
    scheduler.start();
    await waitFor(() => attempts >= 2);
    await scheduler.stop();
    expect(errors.slice(0, 2)).toEqual([['flaky', 'attempt 1'], ['flaky', 'attempt 2']]);
    expect((scheduler.list()[0]!.lastError as Error).message).toMatch(/attempt/);

    const log = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const quiet = createScheduler();
      quiet.cron('boom', '0 0 1 1 *', () => {
        throw new Error('boom');
      });
      await expect(quiet.run('boom')).rejects.toThrow('boom');
      expect(log.mock.calls.some((call) => String(call[0]).includes('Job "boom" failed'))).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  test('run() triggers a job now; runOnStart; duplicate names and bad expressions throw', async () => {
    const scheduler = createScheduler();
    const calls: string[] = [];
    scheduler.cron('report', '0 0 1 1 *', () => {
      calls.push('report');
    });
    scheduler.cron('warmup', '0 0 1 1 *', () => {
      calls.push('warmup');
    }, { runOnStart: true });
    await scheduler.run('report');
    expect(calls).toEqual(['report']);
    scheduler.start();
    await waitFor(() => calls.includes('warmup'));
    expect(() => scheduler.cron('report', '* * * * *', () => undefined)).toThrow(/already exists/);
    expect(() => scheduler.cron('bad', '61 * * * *', () => undefined)).toThrow(SyntaxError);
    await expect(scheduler.run('missing')).rejects.toThrow(/Unknown job/);
    expect(scheduler.remove('report')).toBe(true);
    expect(scheduler.list().map((job) => job.name)).toEqual(['warmup']);
    await scheduler.stop();
  });

  test('stop() waits for running jobs', async () => {
    const scheduler = createScheduler();
    let finished = false;
    scheduler.cron('long', '0 0 1 1 *', async () => {
      await Bun.sleep(150);
      finished = true;
    }, { runOnStart: true });
    scheduler.start();
    await Bun.sleep(10);
    await scheduler.stop();
    expect(finished).toBe(true);
  });

  test('follows the application lifecycle: app.init() starts it, app.close() stops it', async () => {
    let runs = 0;
    const scheduler = createScheduler({ timeZone: 'UTC' }).cron('tick', '* * * * * *', () => {
      runs += 1;
    });
    const app = createApp(defineApplication({
      modules: [defineModule({ providers: [{ provide: Scheduler, useValue: scheduler }], controllers: [], imports: [] })],
    }), { routes: [] });
    expect(() => app.listen({ port: 0 })).toThrow(/app.init\(\)/);
    await app.init();
    await waitFor(() => runs >= 1);
    await app.close();
    const after = runs;
    await Bun.sleep(1100);
    expect(runs).toBe(after);
  });
});
