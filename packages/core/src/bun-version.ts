export const MIN_BUN_VERSION = '1.4.0';

/**
 * Runs once at startup, never per request. Older Bun versions start fine and then misbehave
 * (chunked bodies, WebSocket error handling, health checks), so refusing early is kinder than a silent drift.
 * `version` is injectable so the comparison is testable without a second Bun installed.
 */
export function assertSupportedBun(version: string | undefined = typeof Bun === 'undefined' ? undefined : Bun.version): void {
  if (version === undefined) {
    return;
  }
  if (Bun.semver.order(version, MIN_BUN_VERSION) < 0) {
    throw new Error(`kivin requires Bun ${MIN_BUN_VERSION} or later (running ${version})`);
  }
}
