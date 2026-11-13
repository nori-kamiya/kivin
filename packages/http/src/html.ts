// Auto-escaping HTML templates (equivalent of Hono's `html` helper).

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_PATTERN = /[&<>"']/g;
// Separate non-global pattern for the check: `test` on a /g regex moves `lastIndex` between calls.
const NEEDS_ESCAPE = /[&<>"']/;

/** Markup that is inserted as is (produced by `html` or `raw`). */
export class HtmlString {
  constructor(readonly value: string) {}

  toString() {
    return this.value;
  }
}

/** Escapes text for HTML content and quoted attribute values. */
export function escapeHtml(text: string) {
  return NEEDS_ESCAPE.test(text) ? text.replace(ESCAPE_PATTERN, (character) => ESCAPES[character]!) : text;
}

function render(value: unknown): string {
  if (value === null || value === undefined || value === false || value === true) {
    return '';
  }
  if (value instanceof HtmlString) {
    return value.value;
  }
  if (Array.isArray(value)) {
    return value.map(render).join('');
  }
  return escapeHtml(String(value));
}

/**
 * Tagged template that escapes every interpolated value (strings, numbers, …) unless it is itself
 * `html` / `raw` output. Arrays are concatenated; `null`, `undefined` and booleans render nothing,
 * so `${cond && html`…`}` works.
 *
 * ```ts
 * const page = html`<ul>${items.map((item) => html`<li>${item.name}</li>`)}</ul>`;
 * return htmlResponse(page);
 * ```
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): HtmlString {
  let output = strings[0]!;
  for (let index = 0; index < values.length; index += 1) {
    output += render(values[index]) + strings[index + 1]!;
  }
  return new HtmlString(output);
}

/** Trusted markup inserted without escaping. Never pass user input. */
export function raw(markup: string): HtmlString {
  return new HtmlString(markup);
}

/**
 * A `text/html; charset=utf-8` response. Besides `html` output and strings it takes a stream, e.g.
 * JSX rendered by `react-dom/server`: `htmlResponse(await renderToReadableStream(<Page />))`.
 */
export function htmlResponse(content: HtmlString | string | ReadableStream<Uint8Array>, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) {
    headers.set('content-type', 'text/html; charset=utf-8');
  }
  return new Response(content instanceof HtmlString ? content.value : content, { ...init, headers });
}
