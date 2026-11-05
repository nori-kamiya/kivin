import { createApp, defineApplication, defineModule, type AppManifest } from '@kivin/core';
import { createValibotAdapter } from '@kivin/valibot';
import { describe, expect, test } from 'bun:test';

class A {
  x() {
    return 'A';
  }
}
class B {
  x() {
    return 'B';
  }
}

const route = (controller: typeof A | typeof B, fullPath: string, method: AppManifest['routes'][number]['method'] = 'GET'): AppManifest['routes'][number] => ({
  method,
  fullPath,
  controller,
  methodName: 'x',
  parameters: [],
  guards: [],
  middleware: [],
  filters: [],
  docs: { tags: [], security: [], responses: [] },
});
const build = (routes: AppManifest['routes']) => createApp(defineApplication({
  modules: [defineModule({ providers: [], controllers: [A, B], imports: [] })],
  schemaAdapter: createValibotAdapter(),
}), { routes });

// Before: accepted silently, and `fetch` / Bun's native routes disagreed on the winner.
describe('duplicate routes', () => {
  test.each([
    ['/x', '/x'],
    ['/x', '/x/'],
    ['/u/:id', '/u/:name'],
    ['/u/:id/posts', '/u/:userId/posts/'],
  ])('%p and %p are rejected at startup', (first, second) => {
    expect(() => build([route(A, first), route(B, second)])).toThrow(`Duplicate route: GET ${second} (B.x) conflicts with GET ${first} (A.x)`);
  });

  test('different methods or shapes are fine', () => {
    expect(() => build([route(A, '/x'), route(B, '/x', 'POST'), route(B, '/x/:id'), route(A, '/u/:id'), route(B, '/u/me')])).not.toThrow();
  });
});
