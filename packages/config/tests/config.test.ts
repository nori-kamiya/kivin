import { createApp, createToken, defineApplication, defineModule, type InferSchemaOutput } from '@kivin/core';
import { EnvValidationError, envProvider, loadEnv } from '@kivin/config';
import { createValibotAdapter } from '@kivin/valibot';
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';

const Env = v.object({
  PORT: v.optional(v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(1)), '3000'),
  DATABASE_URL: v.pipe(v.string(), v.url()),
  LOG_LEVEL: v.optional(v.picklist(['debug', 'info', 'warn']), 'info'),
  FEATURE_X: v.optional(v.pipe(v.picklist(['true', 'false']), v.transform((value) => value === 'true')), 'false'),
});

describe('loadEnv', () => {
  test('validates, converts and applies defaults (Standard Schema, no adapter)', () => {
    const env = loadEnv(Env, { source: { DATABASE_URL: 'postgres://db.local/app', FEATURE_X: 'true', UNRELATED: 'x' } });
    expect(env).toEqual({ PORT: 3000, DATABASE_URL: 'postgres://db.local/app', LOG_LEVEL: 'info', FEATURE_X: true });
    const port: number = env.PORT;
    expect(port).toBe(3000);
  });

  test('works through a schema adapter too', () => {
    const env = loadEnv(Env, { adapter: createValibotAdapter(), source: { DATABASE_URL: 'https://x.example', PORT: '8080' } });
    expect(env.PORT).toBe(8080);
  });

  test('reports every invalid variable at once, never their values', () => {
    let error: unknown;
    try {
      loadEnv(Env, { source: { DATABASE_URL: 'not a url s3cr3t', PORT: 'abc', LOG_LEVEL: 'loud' } });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(EnvValidationError);
    const issues = (error as EnvValidationError).issues;
    expect([...new Set(issues.map((issue) => issue.variable))].sort()).toEqual(['DATABASE_URL', 'LOG_LEVEL', 'PORT']);
    const message = (error as Error).message;
    expect(message).toStartWith('Invalid environment variables:\n');
    expect(message).not.toContain('s3cr3t');
    expect(message).not.toContain('loud');
    expect(message).not.toContain('abc');
  });

  test('missing required variables are named', () => {
    expect(() => loadEnv(Env, { source: {} })).toThrow(/DATABASE_URL/);
  });

  test('prefix: only APP_* variables are read, without the prefix', () => {
    const env = loadEnv(Env, { prefix: 'APP_', source: { APP_DATABASE_URL: 'https://a.example', DATABASE_URL: 'ignored', APP_: 'x' } });
    expect(env.DATABASE_URL).toBe('https://a.example');
    try {
      loadEnv(Env, { prefix: 'APP_', source: { APP_PORT: '0' } });
    } catch (error) {
      expect([...new Set((error as EnvValidationError).issues.map((issue) => issue.variable))].sort()).toEqual(['APP_DATABASE_URL', 'APP_PORT']);
    }
  });

  test('rejects schemas it cannot run', () => {
    expect(() => loadEnv({ not: 'a schema' }, { source: {} })).toThrow(TypeError);
    const asyncSchema = { '~standard': { version: 1, vendor: 'x', validate: async () => ({ value: {} }) } };
    expect(() => loadEnv(asyncSchema, { source: {} })).toThrow(/asynchronously/);
  });
});

describe('envProvider', () => {
  test('injects the validated env through DI', () => {
    const ENV = createToken<InferSchemaOutput<typeof Env>>('test.env');

    class Settings {
      constructor(readonly env: InferSchemaOutput<typeof Env>) {}
    }

    const app = createApp(defineApplication({
      modules: [defineModule({ providers: [envProvider(ENV, Env, { source: { DATABASE_URL: 'https://db.example', PORT: '81' } }), { provide: Settings, useFactory: (container) => new Settings(container.resolve(ENV)) }], controllers: [], imports: [] })],
    }), { routes: [] });
    expect(app.get(Settings).env.PORT).toBe(81);
    expect(app.get(ENV).DATABASE_URL).toBe('https://db.example');
  });
});
