import { describe, expect, test } from 'bun:test';

const fixture = new URL('./fixtures/shutdown-readiness.ts', import.meta.url).pathname;

async function start(env: Record<string, string>) {
  const child = Bun.spawn(['bun', 'run', fixture], { cwd: import.meta.dir, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' });
  const decoder = new TextDecoder();
  const reader = child.stdout.getReader();
  let output = '';
  while (!output.includes('\n')) {
    const { value, done } = await reader.read();
    if (done) {
      throw new Error(`fixture exited early: ${await new Response(child.stderr).text()}`);
    }
    output += decoder.decode(value);
  }
  const url = output.split('\n')[0]!.replace('url ', '');
  const rest = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        return output;
      }
      output += decoder.decode(value);
    }
  })();
  return { child, url, rest };
}

describe('listen({ shutdownSignals, shutdownDelayMs, onShutdownStart })', () => {
  test('after the signal readiness fails while requests are still served, then the app closes', async () => {
    const { child, url, rest } = await start({ DELAY_MS: '300' });
    expect((await fetch(new URL('/readyz', url))).status).toBe(200);

    child.kill('SIGTERM');
    await Bun.sleep(100);
    expect((await fetch(new URL('/readyz', url))).status).toBe(503);
    expect((await fetch(new URL('/ping', url))).status).toBe(200);

    expect(await child.exited).toBe(0);
    expect((await rest).split('\n').slice(1, 3)).toEqual(['start SIGTERM', 'shutdown SIGTERM']);
  });

  test('a failing onShutdownStart still closes the app and is logged', async () => {
    const { child, rest } = await start({ DELAY_MS: '0', FAIL_HOOK: '1' });
    child.kill('SIGTERM');

    expect(await child.exited).toBe(0);
    expect(await rest).toContain('shutdown SIGTERM');
    expect(await new Response(child.stderr).text()).toContain('hook failed');
  });

  test('a failing onApplicationShutdown is logged and the process exits 1', async () => {
    const { child } = await start({ DELAY_MS: '0', FAIL_SHUTDOWN: '1' });
    child.kill('SIGTERM');

    expect(await child.exited).toBe(1);
    const stderr = await new Response(child.stderr).text();
    expect(stderr).toContain('[kivin] app.close failed');
    expect(stderr).toContain('db pool close failed');
  });
});
