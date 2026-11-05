// Benchmark app for the performance regression gate (scripts/perf-regression.ts).
//
// The app itself lives in ./app (decorators, schemas, guards, middleware, filters). The gate runs each
// tree's own `kivin generate` on it into ./generated, so base and current are measured exactly as
// users would build them, including whatever the generator emits (e.g. AOT executors).
import { createApp } from '@kivin/core';
import appDefinition from './app/app';
import manifest from './generated/manifest';

export function createBenchApp() {
  return createApp(appDefinition, manifest);
}

export interface BenchScenario {
  name: string;
  /** Expected status, asserted once before timing so a broken route cannot look "fast". */
  status: number;
  request: () => Request;
}

const BASE = 'http://bench.local';
const jsonHeaders = { 'content-type': 'application/json', 'x-api-key': 'secret' };

export const scenarios: BenchScenario[] = [
  { name: 'health-static', status: 200, request: () => new Request(`${BASE}/health`) },
  { name: 'context-json', status: 200, request: () => new Request(`${BASE}/context`) },
  { name: 'list-query', status: 200, request: () => new Request(`${BASE}/users?search=user`) },
  { name: 'get-param', status: 200, request: () => new Request(`${BASE}/users/7`) },
  { name: 'get-filtered-404', status: 404, request: () => new Request(`${BASE}/users/404`) },
  {
    name: 'create-body-guard-mw',
    status: 201,
    request: () => new Request(`${BASE}/users`, { method: 'POST', headers: jsonHeaders, body: '{"name":"Ada","email":"ada@example.com"}' }),
  },
  {
    name: 'patch-body-guard',
    status: 200,
    request: () => new Request(`${BASE}/users/3`, { method: 'PATCH', headers: jsonHeaders, body: '{"name":"Grace"}' }),
  },
  { name: 'delete-204', status: 204, request: () => new Request(`${BASE}/users/5`, { method: 'DELETE', headers: { 'x-api-key': 'secret' } }) },
  { name: 'request-scoped', status: 200, request: () => new Request(`${BASE}/scoped`) },
  { name: 'unknown-404', status: 404, request: () => new Request(`${BASE}/nope`) },
  { name: 'guard-403', status: 403, request: () => new Request(`${BASE}/users`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }) },
];

