// Request body size limits (`@BodyLimit(bytes)` per route, `defineApplication({ bodyLimit })` as the
// default). Bun's `maxRequestBodySize` is one limit for the whole server; this one is per route.
//
// A declared Content-Length over the limit is refused before reading anything. A body without a
// length (chunked) is read while counting and refused as soon as it passes the limit; the bytes read
// are handed on in a new Request, so every body reader downstream works unchanged. Only routes with
// a limit and a body-carrying method are wrapped.
import type { CompiledRoute, ManifestRoute } from './types';

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function resolveBodyLimit<TSchema>(route: ManifestRoute<TSchema>, appLimit: number | undefined) {
  if (!BODY_METHODS.has(route.method)) {
    return undefined;
  }
  const limit = route.docs.bodyLimit ?? appLimit;
  if (limit === undefined) {
    return undefined;
  }
  if (!Number.isFinite(limit) || limit < 0) {
    throw new Error(`Invalid body limit ${String(limit)} for ${route.method} ${route.fullPath}`);
  }
  return limit;
}

const tooLarge = (limit: number) => Response.json({ message: 'Payload Too Large', limit }, { status: 413 });

export function withBodyLimit<TSchema>(compiled: CompiledRoute<TSchema>, limit: number): CompiledRoute<TSchema> {
  const execute = compiled.execute;
  return {
    ...compiled,
    execute: async (request, params) => {
      if (request.body === null) {
        return execute(request, params);
      }
      const declared = request.headers.get('content-length');
      if (declared !== null) {
        return Number(declared) > limit ? tooLarge(limit) : execute(request, params);
      }

      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        total += value.byteLength;
        if (total > limit) {
          await reader.cancel().catch(() => {});
          return tooLarge(limit);
        }
        chunks.push(value);
      }
      const body = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return execute(new Request(request, { body }), params);
    },
  };
}
