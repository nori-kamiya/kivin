// Content negotiation (Accept, Accept-Language, Accept-Encoding, Accept-Charset), RFC 9110 §12.

export interface AcceptEntry {
  /** The value, lower-cased (`text/html`, `en-us`, `gzip`, `*`). */
  value: string;
  /** Quality, 0..1 (default 1). */
  q: number;
  /** Other parameters (`level=1`), names lower-cased. */
  params: Record<string, string>;
}

/** Parses an `Accept*` header into its entries, in header order. Malformed q values count as 0. */
export function parseAcceptHeader(header: string | null | undefined): AcceptEntry[] {
  if (!header) {
    return [];
  }
  const entries: AcceptEntry[] = [];
  for (const part of header.split(',')) {
    const [rawValue, ...rawParams] = part.split(';');
    const value = rawValue!.trim().toLowerCase();
    if (!value) {
      continue;
    }
    let q = 1;
    const params: Record<string, string> = {};
    for (const rawParam of rawParams) {
      const separator = rawParam.indexOf('=');
      if (separator === -1) {
        continue;
      }
      const name = rawParam.slice(0, separator).trim().toLowerCase();
      const paramValue = rawParam.slice(separator + 1).trim().replace(/^"(.*)"$/, '$1');
      if (name === 'q') {
        const parsed = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(paramValue) ? Number(paramValue) : 0;
        q = parsed;
      } else {
        params[name] = paramValue;
      }
    }
    entries.push({ value, q, params });
  }
  return entries;
}

type Matcher = (range: string, candidate: string) => number;

/** Specificity of a media range for a type: 3 exact, 2 `type/*`, 1 `*\/*`, -1 no match. */
const matchMediaType: Matcher = (range, candidate) => {
  if (range === candidate) {
    return 3;
  }
  if (range === '*/*' || range === '*') {
    return 1;
  }
  const slash = range.indexOf('/');
  if (range.endsWith('/*') && candidate.startsWith(range.slice(0, slash + 1))) {
    return 2;
  }
  return -1;
};

/** Language ranges (RFC 4647): exact 4, range is a prefix (`en` for `en-us`) 3, tag is a prefix 2, `*` 1. */
const matchLanguage: Matcher = (range, candidate) => {
  if (range === candidate) {
    return 4;
  }
  if (range === '*') {
    return 1;
  }
  if (candidate.startsWith(`${range}-`)) {
    return 3;
  }
  if (range.startsWith(`${candidate}-`)) {
    return 2;
  }
  return -1;
};

/** Tokens (encodings, charsets): exact 2, `*` 1. */
const matchToken: Matcher = (range, candidate) => (range === candidate ? 2 : range === '*' ? 1 : -1);

function matcherFor(header: string): Matcher {
  switch (header.toLowerCase()) {
    case 'accept':
      return matchMediaType;
    case 'accept-language':
      return matchLanguage;
    default:
      return matchToken;
  }
}

/**
 * Picks the best of `supported` for an `Accept*` header value: highest q (the most specific matching
 * range decides a candidate's q, so `gzip;q=0, *` excludes gzip), then the more specific match, then
 * the client's order for media types / languages, then the order of `supported` (which alone breaks
 * ties for encodings and charsets). An absent / empty header accepts anything (the
 * first supported value). Returns `undefined` when nothing is acceptable (answer 406, or fall back).
 */
export function negotiate<T extends string>(headerName: string, headerValue: string | null | undefined, supported: readonly T[]): T | undefined {
  const entries = parseAcceptHeader(headerValue);
  if (entries.length === 0) {
    // A present but empty Accept-Encoding means "identity only" (RFC 9110 §12.5.3).
    if (headerValue != null && headerName.toLowerCase() === 'accept-encoding') {
      return supported.find((value) => value.toLowerCase() === 'identity');
    }
    return supported[0];
  }
  const match = matcherFor(headerName);
  // Equally acceptable encodings / charsets go by the server's order (browsers list `gzip` before
  // `br`); media types and languages by the client's.
  const preferServerOrder = match === matchToken;
  let best: { value: T; q: number; specificity: number; order: number } | undefined;
  for (const candidate of supported) {
    const normalized = candidate.toLowerCase();
    let chosen: { q: number; specificity: number; order: number } | undefined;
    entries.forEach((entry, order) => {
      const specificity = match(entry.value, normalized);
      if (specificity >= 0 && (!chosen || specificity > chosen.specificity)) {
        chosen = { q: entry.q, specificity, order };
      }
    });
    if (!chosen || chosen.q <= 0) {
      continue;
    }
    if (
      !best
      || chosen.q > best.q
      || (chosen.q === best.q && chosen.specificity > best.specificity)
      || (chosen.q === best.q && chosen.specificity === best.specificity && !preferServerOrder && chosen.order < best.order)
    ) {
      best = { value: candidate, ...chosen };
    }
  }
  return best?.value;
}

/**
 * Content negotiation for a request (Hono's `accepts`): the best supported value for `header`
 * (`Accept`, `Accept-Language`, `Accept-Encoding`, `Accept-Charset`), `fallback` when none is acceptable.
 */
export function accepts<T extends string>(request: Request, header: string, supported: readonly T[], fallback?: T): T | undefined {
  return negotiate(header, request.headers.get(header), supported) ?? fallback;
}

/** Best media type for the request's `Accept` (e.g. `['application/json', 'text/html']`). */
export function acceptsType<T extends string>(request: Request, types: readonly T[], fallback?: T): T | undefined {
  return accepts(request, 'accept', types, fallback);
}

/** Best language for the request's `Accept-Language` (`en` serves `en-US`, and `en-US` accepts `en`). */
export function acceptsLanguage<T extends string>(request: Request, languages: readonly T[], fallback?: T): T | undefined {
  return accepts(request, 'accept-language', languages, fallback);
}

/** Whether an `Accept-Encoding` value allows `encoding` (explicitly or via `*`) with a non-zero q. */
export function acceptsEncoding(header: string, encoding: string) {
  return negotiate('accept-encoding', header, [encoding]) !== undefined;
}
