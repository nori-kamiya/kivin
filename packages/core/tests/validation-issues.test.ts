import { createApp, defineApplication, defineModule, toValidationIssues, type AppManifest } from '@kivin/core';
import { createValibotAdapter } from '@kivin/valibot';
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';

const SignupSchema = v.object({
  email: v.pipe(v.string(), v.email()),
  password: v.pipe(v.string(), v.minLength(12)),
  tags: v.array(v.object({ name: v.pipe(v.string(), v.minLength(1)) })),
});

class Routes {
  signup({ body }: { body: unknown }) {
    return body;
  }
}

const routes: AppManifest['routes'] = [{
  method: 'POST', fullPath: '/signup', controller: Routes, methodName: 'signup',
  parameters: [{ index: 0, source: 'input', fields: ['body'] }], guards: [], middleware: [], filters: [],
  docs: { tags: [], security: [], responses: [], bodySchema: SignupSchema },
}];
const app = createApp(defineApplication({
  modules: [defineModule({ providers: [], controllers: [Routes], imports: [] })],
  schemaAdapter: createValibotAdapter(),
}), { routes });

describe('validation error issues', () => {
  test('are { path, message } and never echo the request body', async () => {
    const response = await app.fetch(new Request('http://x/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nope', password: 'hunter2', tags: [{ name: 'ok' }, { name: '' }] }),
    }));
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain('hunter2');
    expect(JSON.parse(text)).toEqual({
      message: 'body validation failed',
      issues: [
        { path: ['email'], message: expect.stringContaining('email') },
        { path: ['password'], message: expect.stringContaining('length') },
        { path: ['tags', 1, 'name'], message: expect.stringContaining('length') },
      ],
    });
  });

  test('normalises Standard Schema style and unknown issues', () => {
    expect(toValidationIssues([
      { message: 'bad', path: ['a', { key: 2 }, 'c'] },
      { message: 'root' },
      'weird',
    ])).toEqual([
      { path: ['a', 2, 'c'], message: 'bad' },
      { path: [], message: 'root' },
      { path: [], message: 'Invalid value' },
    ]);
    expect(toValidationIssues(undefined)).toEqual([]);
  });
});
