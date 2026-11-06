import { describe, expect, test } from 'bun:test';
import { assertSupportedBun } from '../src/bun-version';

describe('assertSupportedBun', () => {
  test('given a version below the minimum, when asserting, then it throws naming the running version', () => {
    expect(() => assertSupportedBun('1.3.10')).toThrow('kivin requires Bun 1.4.0 or later (running 1.3.10)');
  });

  test('given a prerelease of the minimum, when asserting, then it is rejected as older', () => {
    expect(() => assertSupportedBun('1.4.0-canary.1')).toThrow('running 1.4.0-canary.1');
  });

  for (const version of ['1.4.0', '1.4.4', '2.0.0']) {
    test(`given ${version}, when asserting, then it passes`, () => {
      expect(() => assertSupportedBun(version)).not.toThrow();
    });
  }

  test('given no injected version, when asserting under the running Bun, then it passes', () => {
    expect(() => assertSupportedBun()).not.toThrow();
  });
});
