import { watch, type FSWatcher } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Subprocess } from 'bun';
import { STAGING_PREFIXES } from './staging';

export interface DevOptions {
  /** App definition entry, as for `generate`. */
  entry: string;
  /** Where manifest / contracts / client / openapi are written. */
  outDir: string;
  /** Server entry that imports the generated manifest and starts listening. */
  main: string;
  /** Extra directories to watch. The entry's directory is always watched. */
  watch?: string[];
  debounceMs?: number;
  /** Lifecycle hook, mainly for tests and custom logging. */
  onEvent?: (event: DevEvent) => void;
}

export type DevEvent =
  | { type: 'generated'; durationMs: number }
  | { type: 'generate-failed'; error: string; serverRunning: boolean }
  | { type: 'started'; pid: number }
  | { type: 'change'; files: string[] }
  | { type: 'exited'; code: number | null };

export interface DevHandle {
  /** Resolves after the first generate + start attempt. */
  ready: Promise<void>;
  stop: () => Promise<void>;
}

const IGNORED_SEGMENTS = new Set(['node_modules', '.git', '.kivin', 'dist', 'bin']);

/** Compiled output ships only `bin.js`; running from TypeScript source finds `bin.ts` instead. */
export function resolveCliBin(directory: string): string {
  const source = join(directory, 'bin.ts');
  return existsSync(source) ? source : join(directory, 'bin.js');
}

const binPath = resolveCliBin(import.meta.dir);

/**
 * `kivin dev`: generate the manifest, start the server, and on every source change regenerate and
 * restart it. A failed generate keeps the previous server running so a typo never takes the app
 * down mid-edit.
 */
export function startDev(options: DevOptions): DevHandle {
  const entry = resolve(options.entry);
  const outDir = resolve(options.outDir);
  const main = resolve(options.main);
  const debounceMs = options.debounceMs ?? 80;
  const emit = options.onEvent ?? logEvent;
  const watchRoots = [...new Set([dirname(entry), dirname(main), ...(options.watch ?? []).map((directory) => resolve(directory))])];

  const missing = watchRoots.find((root) => !existsSync(root));
  if (missing !== undefined) {
    throw new Error(`kivin dev: watch directory does not exist: ${missing}`);
  }

  let child: Subprocess | undefined;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();
  const pending = new Set<string>();

  const generate = async () => {
    const startedAt = performance.now();
    const processHandle = Bun.spawn([process.execPath, binPath, 'generate', '--entry', entry, '--outDir', outDir], {
      stdout: 'ignore',
      stderr: 'pipe',
      env: process.env,
    });
    const [code, stderr] = await Promise.all([processHandle.exited, new Response(processHandle.stderr).text()]);
    if (code !== 0) {
      emit({ type: 'generate-failed', error: stderr.trim() || `generate exited with code ${code}`, serverRunning: child !== undefined && child.exitCode === null && child.signalCode === null });
      return false;
    }
    emit({ type: 'generated', durationMs: Math.round(performance.now() - startedAt) });
    return true;
  };

  const stopChild = async () => {
    const current = child;
    child = undefined;
    if (!current || current.exitCode !== null) {
      return;
    }
    current.kill('SIGTERM');
    const exited = await Promise.race([current.exited.then(() => true), Bun.sleep(3000).then(() => false)]);
    if (!exited) {
      current.kill('SIGKILL');
      await current.exited;
    }
  };

  const startChild = () => {
    const processHandle = Bun.spawn([process.execPath, main], { stdout: 'inherit', stderr: 'inherit', stdin: 'inherit', env: process.env });
    child = processHandle;
    emit({ type: 'started', pid: processHandle.pid });
    void processHandle.exited.then((code) => {
      // Only report exits we did not cause ourselves (crashes or the server stopping on its own).
      const killedBySignal = processHandle.signalCode === 'SIGTERM' || processHandle.signalCode === 'SIGINT';
      if (child === processHandle && !stopped && !killedBySignal) {
        emit({ type: 'exited', code });
      }
    });
  };

  const cycle = async () => {
    if (await generate()) {
      await stopChild();
      if (!stopped) {
        startChild();
      }
    }
  };

  const ready = (running = cycle());

  const onChange = (root: string, fileName: string | null) => {
    if (!fileName || stopped) {
      return;
    }
    const absolute = resolve(root, fileName);
    if (absolute.startsWith(outDir + sep) || relative(root, absolute).split(sep).some((segment) => IGNORED_SEGMENTS.has(segment) || STAGING_PREFIXES.some((prefix) => segment.startsWith(prefix)))) {
      return;
    }
    if (!/\.(ts|tsx|mts|cts|js|mjs|json)$/.test(absolute)) {
      return;
    }
    pending.add(absolute);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const files = [...pending];
      pending.clear();
      running = running.then(async () => {
        if (stopped) {
          return;
        }
        emit({ type: 'change', files });
        await cycle();
      });
    }, debounceMs);
  };

  const watchers: FSWatcher[] = watchRoots.map((root) => watch(root, { recursive: true }, (_event, fileName) => onChange(root, fileName?.toString() ?? null)));

  return {
    ready,
    async stop() {
      stopped = true;
      clearTimeout(timer);
      for (const watcher of watchers) {
        watcher.close();
      }
      await running.catch(() => undefined);
      await stopChild();
    },
  };
}

function logEvent(event: DevEvent) {
  const prefix = '\x1b[36m[kivin dev]\x1b[0m';
  switch (event.type) {
    case 'generated':
      console.log(`${prefix} generated manifest, contracts and client in ${event.durationMs}ms`);
      break;
    case 'generate-failed':
      console.error(`${prefix} \x1b[31mgenerate failed, ${event.serverRunning ? 'keeping the previous server running' : 'no server is running yet; fix the error and save to retry'}\x1b[0m\n${event.error}`);
      break;
    case 'started':
      console.log(`${prefix} server started (pid ${event.pid})`);
      break;
    case 'change':
      console.log(`${prefix} change: ${event.files.map((file) => relative(process.cwd(), file)).join(', ')}`);
      break;
    case 'exited':
      console.error(`${prefix} server exited with code ${event.code}; waiting for changes`);
      break;
  }
}
