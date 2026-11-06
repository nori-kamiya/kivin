import { createApp, defineApplication, defineModule, type AppManifest, type RequestContext } from '@kivinjs/core';
import { createValibotAdapter } from '@kivinjs/valibot';
import { beforeAll, describe, expect, test } from 'bun:test';
import { createJwtGuard, createLocalJwks, createRemoteJwks, getJwtPayload, JwksFetchError, JwtError, signJwt, verifyJwt, type JsonWebKeySet } from '../src/index';

const NOW = 1_800_000_000;
const now = () => NOW;

async function rsaPair(kid: string) {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { kid, privateKey: pair.privateKey, publicJwk: { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid, use: 'sig', alg: 'RS256' }, privateJwk };
}

async function ecPair(kid: string) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { kid, privateKey: pair.privateKey, publicJwk: { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid } };
}

const expectCode = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(JwtError);
  expect((error as JwtError).code).toBe(code);
};

/** A fake JWKS endpoint whose key set and status can be changed between requests. */
function fakeEndpoint(initial: JsonWebKeySet) {
  const state = { jwks: initial as unknown, status: 200, calls: 0, cacheControl: undefined as string | undefined, fail: false };
  const fetch = async (request: Request) => {
    state.calls += 1;
    expect(request.url).toBe('https://issuer.test/.well-known/jwks.json');
    if (state.fail) {
      throw new TypeError('network down');
    }
    return Response.json(state.jwks, { status: state.status, headers: state.cacheControl ? { 'cache-control': state.cacheControl } : {} });
  };
  return { state, fetch };
}

describe('JWKS key resolvers', () => {
  let rs1: Awaited<ReturnType<typeof rsaPair>>;
  let rs2: Awaited<ReturnType<typeof rsaPair>>;
  let ec1: Awaited<ReturnType<typeof ecPair>>;

  beforeAll(async () => {
    [rs1, rs2, ec1] = await Promise.all([rsaPair('rs-1'), rsaPair('rs-2'), ecPair('ec-1')]);
  });

  const token = (key: { kid: string; privateKey: CryptoKey }, algorithm: 'RS256' | 'ES256', kid: string | undefined = key.kid) =>
    signJwt({ sub: 'u1' }, { key: key.privateKey, algorithm, expiresInSec: 60, now, ...(kid ? { keyId: kid } : {}) });

  test('local JWKS picks the key by kid and algorithm', async () => {
    const key = createLocalJwks({ keys: [rs1.publicJwk, rs2.publicJwk, ec1.publicJwk] });
    expect((await verifyJwt(await token(rs2, 'RS256'), { key, algorithms: ['RS256', 'ES256'], now })).sub).toBe('u1');
    expect((await verifyJwt(await token(ec1, 'ES256'), { key, algorithms: ['RS256', 'ES256'], now })).sub).toBe('u1');
  });

  test('a kid that names a key of another type or algorithm is not used', async () => {
    const key = createLocalJwks({ keys: [rs1.publicJwk, ec1.publicJwk] });
    // ES256 token claiming the RSA key's kid: no ES256-capable key with that kid.
    await expectCode(verifyJwt(await token(ec1, 'ES256', 'rs-1'), { key, algorithms: ['ES256'], now }), 'key');
    // Signed by rs-2 but claims rs-1: the key is found, the signature does not match.
    await expectCode(verifyJwt(await token(rs2, 'RS256', 'rs-1'), { key, algorithms: ['RS256'], now }), 'signature');
  });

  test('without a kid only an unambiguous key is used', async () => {
    await expectCode(verifyJwt(await token(rs1, 'RS256', ''), { key: createLocalJwks({ keys: [rs1.publicJwk, rs2.publicJwk] }), algorithms: ['RS256'], now }), 'key');
    expect((await verifyJwt(await token(rs1, 'RS256', ''), { key: createLocalJwks({ keys: [rs1.publicJwk, ec1.publicJwk] }), algorithms: ['RS256'], now })).sub).toBe('u1');
  });

  test('private key parts in a JWKS are ignored and enc keys are skipped', async () => {
    const key = createLocalJwks({ keys: [{ ...rs1.privateJwk, kid: 'rs-1' }, { ...rs2.publicJwk, use: 'enc' }] });
    expect((await verifyJwt(await token(rs1, 'RS256'), { key, algorithms: ['RS256'], now })).sub).toBe('u1');
    await expectCode(verifyJwt(await token(rs2, 'RS256'), { key, algorithms: ['RS256'], now }), 'key');
  });

  test('remote JWKS is fetched once and cached', async () => {
    const endpoint = fakeEndpoint({ keys: [rs1.publicJwk] });
    const key = createRemoteJwks('https://issuer.test/.well-known/jwks.json', { fetch: endpoint.fetch });
    const tokens = await Promise.all([token(rs1, 'RS256'), token(rs1, 'RS256'), token(rs1, 'RS256')]);
    await Promise.all(tokens.map((value) => verifyJwt(value, { key, algorithms: ['RS256'], now })));
    await verifyJwt(tokens[0]!, { key, algorithms: ['RS256'], now });
    expect(endpoint.state.calls).toBe(1);
  });

  test('an unknown kid refreshes once (key rotation), rate limited by the cooldown', async () => {
    let clock = 0;
    const endpoint = fakeEndpoint({ keys: [rs1.publicJwk] });
    const key = createRemoteJwks('https://issuer.test/.well-known/jwks.json', { fetch: endpoint.fetch, cooldownSec: 30, now: () => clock });
    await verifyJwt(await token(rs1, 'RS256'), { key, algorithms: ['RS256'], now });
    expect(endpoint.state.calls).toBe(1);

    // Rotation: rs-2 appears. Right after a fetch the cooldown blocks a refetch...
    endpoint.state.jwks = { keys: [rs1.publicJwk, rs2.publicJwk] };
    await expectCode(verifyJwt(await token(rs2, 'RS256'), { key, algorithms: ['RS256'], now }), 'key');
    expect(endpoint.state.calls).toBe(1);

    // ...after it, one refetch finds the new key.
    clock = 31_000;
    expect((await verifyJwt(await token(rs2, 'RS256'), { key, algorithms: ['RS256'], now })).sub).toBe('u1');
    expect(endpoint.state.calls).toBe(2);

    // Random kids cannot make it refetch again within the cooldown.
    for (let index = 0; index < 5; index += 1) {
      await expectCode(verifyJwt(await token(rs1, 'RS256', `random-${index}`), { key, algorithms: ['RS256'], now }), 'key');
    }
    expect(endpoint.state.calls).toBe(2);
  });

  test('the cache TTL follows Cache-Control max-age and keys are refreshed after it', async () => {
    let clock = 0;
    const endpoint = fakeEndpoint({ keys: [rs1.publicJwk] });
    endpoint.state.cacheControl = 'public, max-age=60';
    const key = createRemoteJwks('https://issuer.test/.well-known/jwks.json', { fetch: endpoint.fetch, now: () => clock });
    const value = await token(rs1, 'RS256');
    await verifyJwt(value, { key, algorithms: ['RS256'], now });
    clock = 59_000;
    await verifyJwt(value, { key, algorithms: ['RS256'], now });
    expect(endpoint.state.calls).toBe(1);
    clock = 61_000;
    await verifyJwt(value, { key, algorithms: ['RS256'], now });
    expect(endpoint.state.calls).toBe(2);
  });

  test('a failed refresh keeps the previous keys; a failed first fetch is a JwksFetchError', async () => {
    let clock = 0;
    const endpoint = fakeEndpoint({ keys: [rs1.publicJwk] });
    const key = createRemoteJwks('https://issuer.test/.well-known/jwks.json', { fetch: endpoint.fetch, cacheTtlSec: 10, now: () => clock });
    const value = await token(rs1, 'RS256');
    await verifyJwt(value, { key, algorithms: ['RS256'], now });
    endpoint.state.fail = true;
    clock = 20_000;
    expect((await verifyJwt(value, { key, algorithms: ['RS256'], now })).sub).toBe('u1');

    const broken = fakeEndpoint({ keys: [] });
    broken.state.status = 500;
    const brokenKey = createRemoteJwks('https://issuer.test/.well-known/jwks.json', { fetch: broken.fetch });
    expect(await verifyJwt(value, { key: brokenKey, algorithms: ['RS256'], now }).catch((error: unknown) => error)).toBeInstanceOf(JwksFetchError);

    const invalid = fakeEndpoint({ keys: [] });
    invalid.state.jwks = { nope: true };
    expect(await verifyJwt(value, { key: createRemoteJwks('https://issuer.test/.well-known/jwks.json', { fetch: invalid.fetch }), algorithms: ['RS256'], now }).catch((error: unknown) => error)).toBeInstanceOf(JwksFetchError);
  });

  test('the guard answers 401 for unknown keys and 503 when the JWKS is unavailable', async () => {
    const endpoint = fakeEndpoint({ keys: [rs1.publicJwk] });
    const AuthGuard = createJwtGuard({ key: createRemoteJwks('https://issuer.test/.well-known/jwks.json', { fetch: endpoint.fetch }), algorithms: ['RS256'] });
    const down = fakeEndpoint({ keys: [] });
    down.state.fail = true;
    const DownGuard = createJwtGuard({ key: createRemoteJwks('https://issuer.test/.well-known/jwks.json', { fetch: down.fetch }), algorithms: ['RS256'] });

    class MeController {
      me(context: RequestContext) {
        return { sub: getJwtPayload(context)?.sub ?? null };
      }
    }
    const route = (fullPath: string, guard: unknown): AppManifest['routes'][number] => ({
      method: 'GET', fullPath, controller: MeController, methodName: 'me',
      parameters: [{ index: 0, source: 'context' }], guards: [guard as never], middleware: [], filters: [],
      docs: { tags: [], security: [], responses: [] },
    });
    const app = createApp(defineApplication({
      modules: [defineModule({ providers: [AuthGuard, DownGuard], controllers: [MeController], imports: [] })],
      schemaAdapter: createValibotAdapter(),
    }), { routes: [route('/me', AuthGuard), route('/down', DownGuard)] });

    const good = await signJwt({ sub: 'u1' }, { key: rs1.privateKey, algorithm: 'RS256', expiresInSec: 60, keyId: 'rs-1' });
    expect(await (await app.fetch(new Request('http://x/me', { headers: { authorization: `Bearer ${good}` } }))).json()).toEqual({ sub: 'u1' });

    const unknown = await signJwt({ sub: 'u1' }, { key: rs2.privateKey, algorithm: 'RS256', expiresInSec: 60, keyId: 'rs-2' });
    const rejected = await app.fetch(new Request('http://x/me', { headers: { authorization: `Bearer ${unknown}` } }));
    expect(rejected.status).toBe(401);
    expect(rejected.headers.get('www-authenticate')).toContain('error_description="key"');

    const unavailable = await app.fetch(new Request('http://x/down', { headers: { authorization: `Bearer ${good}` } }));
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get('retry-after')).toBe('5');
  });
});
