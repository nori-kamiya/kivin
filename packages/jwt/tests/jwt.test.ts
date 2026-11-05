import { createApp, defineApplication, defineModule, type AppManifest, type RequestContext } from '@kivin/core';
import { createValibotAdapter } from '@kivin/valibot';
import { describe, expect, test } from 'bun:test';
import { createJwtGuard, getJwtPayload, JwtError, signJwt, verifyJwt } from '../src/index';

const SECRET = 'test-secret-that-is-long-enough-for-hs256';
const NOW = 1_800_000_000;
const now = () => NOW;

describe('signJwt / verifyJwt', () => {
  test('round-trips HS256 with registered claims', async () => {
    const token = await signJwt({ role: 'admin' }, { key: SECRET, algorithm: 'HS256', expiresInSec: 60, issuer: 'kivin', audience: 'api', subject: 'u1', now });
    const payload = await verifyJwt(token, { key: SECRET, algorithms: ['HS256'], issuer: 'kivin', audience: 'api', now });
    expect(payload).toEqual({ role: 'admin', iat: NOW, exp: NOW + 60, iss: 'kivin', aud: 'api', sub: 'u1' });
  });

  test('round-trips ES256 and RS256 with generated key pairs', async () => {
    const ec = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const ecToken = await signJwt({ ok: 1 }, { key: ec.privateKey, algorithm: 'ES256', expiresInSec: 60, now });
    expect((await verifyJwt(ecToken, { key: ec.publicKey, algorithms: ['ES256'], now })).ok).toBe(1);

    const rsa = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    const rsaToken = await signJwt({ ok: 2 }, { key: rsa.privateKey, algorithm: 'RS256', expiresInSec: 60, now });
    const publicJwk = await crypto.subtle.exportKey('jwk', rsa.publicKey);
    expect((await verifyJwt(rsaToken, { key: publicJwk, algorithms: ['RS256'], now })).ok).toBe(2);
  });

  const expectCode = async (promise: Promise<unknown>, code: string) => {
    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JwtError);
    expect((error as JwtError).code).toBe(code);
  };

  test('rejects algorithms outside the allow list, including alg=none', async () => {
    const token = await signJwt({}, { key: SECRET, algorithm: 'HS512', expiresInSec: 60, now });
    await expectCode(verifyJwt(token, { key: SECRET, algorithms: ['HS256'], now }), 'algorithm');

    const unsigned = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(`{"exp":${NOW + 60}}`).toString('base64url')}.`;
    await expectCode(verifyJwt(unsigned, { key: SECRET, algorithms: ['HS256'], now }), 'algorithm');
  });

  test('rejects tampered payloads and wrong keys', async () => {
    const token = await signJwt({ role: 'user' }, { key: SECRET, algorithm: 'HS256', expiresInSec: 60, now });
    const [header, , signature] = token.split('.');
    const forged = `${header}.${Buffer.from(JSON.stringify({ role: 'admin', exp: NOW + 60 })).toString('base64url')}.${signature}`;
    await expectCode(verifyJwt(forged, { key: SECRET, algorithms: ['HS256'], now }), 'signature');
    await expectCode(verifyJwt(token, { key: 'another-secret', algorithms: ['HS256'], now }), 'signature');
  });

  test('enforces exp, nbf, required claims, issuer and audience', async () => {
    const expired = await signJwt({}, { key: SECRET, algorithm: 'HS256', expiresInSec: -1, now });
    await expectCode(verifyJwt(expired, { key: SECRET, algorithms: ['HS256'], now }), 'expired');
    expect(await verifyJwt(expired, { key: SECRET, algorithms: ['HS256'], now, clockToleranceSec: 5 })).toBeDefined();

    const early = await signJwt({}, { key: SECRET, algorithm: 'HS256', expiresInSec: 60, notBeforeSec: 30, now });
    await expectCode(verifyJwt(early, { key: SECRET, algorithms: ['HS256'], now }), 'not-yet-valid');

    const noExp = await signJwt({ a: 1 }, { key: SECRET, algorithm: 'HS256', now });
    await expectCode(verifyJwt(noExp, { key: SECRET, algorithms: ['HS256'], now }), 'claim');
    expect((await verifyJwt(noExp, { key: SECRET, algorithms: ['HS256'], requiredClaims: [], now })).a).toBe(1);

    const scoped = await signJwt({}, { key: SECRET, algorithm: 'HS256', expiresInSec: 60, issuer: 'a', audience: ['x', 'y'], now });
    await expectCode(verifyJwt(scoped, { key: SECRET, algorithms: ['HS256'], issuer: 'b', now }), 'claim');
    expect(await verifyJwt(scoped, { key: SECRET, algorithms: ['HS256'], audience: 'y', now })).toBeDefined();
    await expectCode(verifyJwt(scoped, { key: SECRET, algorithms: ['HS256'], audience: 'z', now }), 'claim');
  });

  test('rejects malformed tokens', async () => {
    await expectCode(verifyJwt('a.b', { key: SECRET, algorithms: ['HS256'] }), 'malformed');
    await expectCode(verifyJwt('!!!.e30.sig', { key: SECRET, algorithms: ['HS256'] }), 'malformed');
  });
});

describe('createJwtGuard', () => {
  const AuthGuard = createJwtGuard({
    key: SECRET,
    algorithms: ['HS256'],
    cookie: 'token',
    authorize: (payload) => payload.role !== 'banned',
  });

  class MeController {
    me(context: RequestContext) {
      return { sub: getJwtPayload(context)?.sub ?? null };
    }
  }

  const manifest: AppManifest = {
    routes: [{
      method: 'GET', fullPath: '/me', controller: MeController, methodName: 'me',
      parameters: [{ index: 0, source: 'context' }], guards: [AuthGuard], middleware: [], filters: [],
      docs: { tags: [], security: [], responses: [] },
    }],
  };
  const app = createApp(defineApplication({
    modules: [defineModule({ providers: [AuthGuard], controllers: [MeController], imports: [] })],
    schemaAdapter: createValibotAdapter(),
  }), manifest);

  test('passes the verified payload to the handler', async () => {
    const token = await signJwt({ sub: 'user-1' }, { key: SECRET, algorithm: 'HS256', expiresInSec: 60 });
    const response = await app.fetch(new Request('http://x/me', { headers: { authorization: `Bearer ${token}` } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sub: 'user-1' });
  });

  test('accepts the token from a cookie', async () => {
    const token = await signJwt({ sub: 'cookie-user' }, { key: SECRET, algorithm: 'HS256', expiresInSec: 60 });
    const response = await app.fetch(new Request('http://x/me', { headers: { cookie: `token=${token}` } }));
    expect(await response.json()).toEqual({ sub: 'cookie-user' });
  });

  test('answers 401 with WWW-Authenticate for missing or invalid tokens', async () => {
    const missing = await app.fetch(new Request('http://x/me'));
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toBe('Bearer');

    const expired = await signJwt({ sub: 'u' }, { key: SECRET, algorithm: 'HS256', expiresInSec: -10 });
    const invalid = await app.fetch(new Request('http://x/me', { headers: { authorization: `Bearer ${expired}` } }));
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  test('answers 403 when authorize() rejects the payload', async () => {
    const token = await signJwt({ sub: 'u', role: 'banned' }, { key: SECRET, algorithm: 'HS256', expiresInSec: 60 });
    const response = await app.fetch(new Request('http://x/me', { headers: { authorization: `Bearer ${token}` } }));
    expect(response.status).toBe(403);
  });
});
