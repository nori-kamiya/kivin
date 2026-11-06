// Pretty-printed JSON on demand (equivalent of Hono's `prettyJSON`).
import type { NestLikeMiddleware, RequestContext } from '@kivin/core';

export interface PrettyJsonOptions {
  /** Query parameter that turns indentation on (`?pretty`). Default `pretty`. */
  query?: string;
  /** `JSON.stringify` indentation. Default 2. */
  space?: number | string;
}

const JSON_TYPE = /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i;

/**
 * Re-indents JSON responses when the request has `?pretty` (handy when reading an API in a
 * browser). Other requests are untouched and pay one `includes('?')` check.
 */
export function createPrettyJsonMiddleware(options: PrettyJsonOptions = {}) {
  const query = options.query ?? 'pretty';
  const space = options.space ?? 2;

  const wantsPretty = (url: string) => {
    const queryStart = url.indexOf('?');
    return queryStart !== -1 && new URLSearchParams(url.slice(queryStart + 1)).has(query);
  };

  const prettify = async (response: Response) => {
    if (response.body === null || !JSON_TYPE.test(response.headers.get('content-type') ?? '')) {
      return response;
    }
    const text = await response.text();
    let formatted = text;
    try {
      formatted = JSON.stringify(JSON.parse(text), null, space);
    } catch {
      // Not valid JSON after all: send it unchanged.
    }
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    return new Response(formatted, { status: response.status, statusText: response.statusText, headers });
  };

  const run = (url: string, next: () => Response | PromiseLike<Response>) =>
    wantsPretty(url) ? Promise.resolve(next()).then(prettify) : next();

  return class PrettyJsonMiddleware implements NestLikeMiddleware {
    handle(context: RequestContext, next: () => Response | PromiseLike<Response>) {
      return run(context.request.url, next);
    }

    handleRaw(request: Request, _params: Record<string, string>, _state: unknown, next: () => Response | PromiseLike<Response>) {
      return run(request.url, next);
    }
  };
}
