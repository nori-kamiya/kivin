// Locale detectors: each reads one source of the request and names a candidate language; the i18n
// instance matches candidates against its languages and takes the first that matches.
import { getCookie } from '@kivinjs/core';
import { acceptsLanguage } from '@kivinjs/http';

export interface LocaleDetector {
  /** A candidate language for `request`, matched against `locales` by the caller. */
  detect(request: Request, locales: readonly string[]): string | undefined;
  /** Request header the answer depends on, for `Vary`. */
  readonly vary?: string;
  /** The request to route instead (a path prefix stripped), when this detector rewrites it. */
  rewrite?(request: Request, locales: readonly string[]): Request | undefined;
}

/** `?lang=ja` (the name is configurable). */
export function fromQuery(name = 'lang'): LocaleDetector {
  return {
    detect: (request) => new URL(request.url).searchParams.get(name) ?? undefined,
  };
}

/** A `lang=ja` cookie (the name is configurable). */
export function fromCookie(name = 'lang'): LocaleDetector {
  return {
    detect: (request) => getCookie(request, name),
    vary: 'Cookie',
  };
}

/** The best of the request's `Accept-Language` among the languages (none when the header is absent). */
export function fromAcceptLanguage(): LocaleDetector {
  return {
    detect: (request, locales) => (request.headers.get('accept-language') ? acceptsLanguage(request, locales) : undefined),
    vary: 'Accept-Language',
  };
}

function prefixOf(request: Request, locales: readonly string[]) {
  const url = new URL(request.url);
  const segment = /^\/([^/]+)/.exec(url.pathname)?.[1];
  const locale = segment === undefined ? undefined : locales.find((candidate) => candidate.toLowerCase() === segment.toLowerCase());
  return locale === undefined ? undefined : { url, locale, rest: url.pathname.slice(segment!.length + 1) || '/' };
}

export interface PathPrefixOptions {
  /**
   * Route `/ja/users` as `/users` (default true), so controllers need no `:lang` param. Needs the
   * i18n `onRequest` hook.
   */
  strip?: boolean;
}

/** The first path segment when it is one of the languages (`/ja/users`). */
export function fromPathPrefix(options: PathPrefixOptions = {}): LocaleDetector {
  const strip = options.strip ?? true;
  return {
    detect: (request, locales) => prefixOf(request, locales)?.locale,
    ...(strip
      ? {
          rewrite: (request: Request, locales: readonly string[]) => {
            const prefix = prefixOf(request, locales);
            if (!prefix) {
              return undefined;
            }
            prefix.url.pathname = prefix.rest;
            return new Request(prefix.url, request);
          },
        }
      : {}),
  };
}

/** `candidate` as one of `locales`: an exact match (any case), else the same language (`ja-JP` → `ja`, `en` → `en-US`). */
export function matchLocale<L extends string>(candidate: string, locales: readonly L[]): L | undefined {
  const lower = candidate.trim().toLowerCase();
  if (lower === '') {
    return undefined;
  }
  const exact = locales.find((locale) => locale.toLowerCase() === lower);
  if (exact) {
    return exact;
  }
  const language = lower.split('-')[0]!;
  return locales.find((locale) => locale.toLowerCase() === language) ?? locales.find((locale) => locale.toLowerCase().split('-')[0] === language);
}
