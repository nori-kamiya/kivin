import { createApp, defineApplication, defineModule, type AppManifest } from '@kivinjs/core';
import { createIpMatcher, createIpRestriction, createIpRestrictionGuard, parseIpAddress } from '@kivinjs/security';
import { describe, expect, test } from 'bun:test';

describe('parseIpAddress', () => {
  test('IPv4, IPv6 (compressed, embedded IPv4, zone, brackets), IPv4-mapped as IPv4', () => {
    expect(parseIpAddress('192.168.0.1')).toEqual({ family: 4, bytes: new Uint8Array([192, 168, 0, 1]) });
    expect(parseIpAddress('::1')?.family).toBe(6);
    expect(parseIpAddress('::1')?.bytes[15]).toBe(1);
    expect(parseIpAddress('2001:db8::8a2e:370:7334')?.bytes.slice(0, 4)).toEqual(new Uint8Array([0x20, 0x01, 0x0d, 0xb8]));
    expect(parseIpAddress('[fe80::1%eth0]')?.family).toBe(6);
    expect(parseIpAddress('::ffff:10.1.2.3')).toEqual({ family: 4, bytes: new Uint8Array([10, 1, 2, 3]) });
    expect(parseIpAddress('64:ff9b::192.0.2.33')?.bytes.slice(12)).toEqual(new Uint8Array([192, 0, 2, 33]));
  });

  test('rejects malformed input', () => {
    for (const bad of ['', '1.2.3', '1.2.3.4.5', '256.0.0.1', '01.2.3.4', '1.2.3.-1', '1::2::3', '12345::', 'g::1', '1:2:3:4:5:6:7:8:9', 'localhost', '::ffff:1.2.3']) {
      expect({ bad, parsed: parseIpAddress(bad) }).toEqual({ bad, parsed: undefined });
    }
  });
});

describe('createIpMatcher', () => {
  test('exact, CIDR (byte and bit boundaries), wildcard, predicate', () => {
    const match = createIpMatcher(['10.0.0.0/8', '192.168.1.128/25', '203.0.113.7', '2001:db8::/32', (address) => address.endsWith('.99')]);
    expect(match('10.255.0.1')).toBe(true);
    expect(match('11.0.0.1')).toBe(false);
    expect(match('192.168.1.200')).toBe(true);
    expect(match('192.168.1.127')).toBe(false);
    expect(match('203.0.113.7')).toBe(true);
    expect(match('203.0.113.8')).toBe(false);
    expect(match('2001:db8:1234::1')).toBe(true);
    expect(match('2001:db9::1')).toBe(false);
    expect(match('172.16.0.99')).toBe(true);
    expect(match('::ffff:10.1.1.1')).toBe(true);
    expect(match('not an ip')).toBe(false);
    expect(createIpMatcher(['*'])('::1')).toBe(true);
    expect(createIpMatcher(['0.0.0.0/0'])('8.8.8.8')).toBe(true);
    expect(createIpMatcher(['0.0.0.0/0'])('::1')).toBe(false);
    expect(createIpMatcher(['::ffff:10.0.0.0/104'])('10.9.9.9')).toBe(true);
  });

  test('invalid rules throw up front', () => {
    for (const bad of ['10.0.0.0/33', '10.0.0.0/x', 'nope', '::/129', '1.2.3.4/']) {
      expect(() => createIpMatcher([bad])).toThrow(TypeError);
    }
  });
});

describe('createIpRestriction', () => {
  const request = (address: string | undefined) => ({ address, request: new Request('http://localhost/') });
  const check = (options: Parameters<typeof createIpRestriction>[0]) => {
    const passes = createIpRestriction(options);
    return (address: string | undefined) => {
      const { request: req } = request(address);
      return passes(Object.assign(req, { address }));
    };
  };
  const getAddress = (req: Request) => (req as Request & { address?: string }).address;

  test('deny wins over allow; allow list restricts; unknown fails closed by default', () => {
    const passes = check({ allow: ['10.0.0.0/8'], deny: ['10.0.0.13'], getAddress });
    expect(passes('10.1.2.3')).toBe(true);
    expect(passes('10.0.0.13')).toBe(false);
    expect(passes('192.168.0.1')).toBe(false);
    expect(passes(undefined)).toBe(false);
    expect(passes('garbage')).toBe(false);

    const denyOnly = check({ deny: ['192.0.2.0/24'], getAddress });
    expect(denyOnly('192.0.2.10')).toBe(false);
    expect(denyOnly('198.51.100.1')).toBe(true);

    expect(check({ deny: ['192.0.2.0/24'], getAddress, unknown: 'allow' })(undefined)).toBe(true);
  });

  test('requires at least one rule', () => {
    expect(() => createIpRestriction({})).toThrow(TypeError);
    expect(() => createIpRestriction({ allow: [] })).toThrow(TypeError);
  });
});

describe('createIpRestrictionGuard', () => {
  class Routes {
    secret() {
      return { ok: true };
    }
  }
  const manifest: AppManifest = {
    routes: [{ method: 'GET', fullPath: '/secret', controller: Routes, methodName: 'secret', parameters: [], guards: [], middleware: [], filters: [], docs: { tags: [], security: [], responses: [] } }],
  };

  test('uses the peer address from listen(): 127.0.0.1 allowed, others 403', async () => {
    const allowLocal = createApp(defineApplication({
      modules: [defineModule({ providers: [], controllers: [Routes], imports: [] })],
      globals: { guards: [createIpRestrictionGuard({ allow: ['127.0.0.1', '::1'] })] },
    }), manifest);
    const denyLocal = createApp(defineApplication({
      modules: [defineModule({ providers: [], controllers: [Routes], imports: [] })],
      globals: { guards: [createIpRestrictionGuard({ deny: ['127.0.0.0/8'] })] },
    }), manifest);
    const allowed = allowLocal.listen({ port: 0, hostname: '127.0.0.1' });
    const denied = denyLocal.listen({ port: 0, hostname: '127.0.0.1' });
    try {
      expect(await (await fetch(new URL('/secret', allowed.url))).json()).toEqual({ ok: true });
      const response = await fetch(new URL('/secret', denied.url));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ message: 'Forbidden' });
      // app.fetch has no peer address: fails closed.
      expect((await allowLocal.fetch(new Request('http://localhost/secret'))).status).toBe(403);
    } finally {
      await allowLocal.close();
      await denyLocal.close();
    }
  });
});
