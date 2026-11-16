// @kivinjs/i18n: picks each request's language from an ordered list of detectors and translates with
// typed message catalogs (keys and params derived from the default catalog), formatting with Intl.
import { afterResponse, getValidationFailure, originalRequest, RequestContext, toValidationIssues, type FactoryProvider, type InjectionToken, type RequestHook } from '@kivinjs/core';
import { compileCatalog, Formatter, type Catalog, type FormatOptions, type Translator } from './catalog';
import { fromAcceptLanguage, matchLocale, type LocaleDetector } from './detect';

export {
  defineMessages,
  defineTranslation,
  plural,
  type Catalog,
  type FormatOptions,
  type MessageArgs,
  type MessageKey,
  type MessageParams,
  type Plural,
  type PluralCategory,
  type PluralForms,
  type Translation,
  type Translator,
} from './catalog';
export { fromAcceptLanguage, fromCookie, fromPathPrefix, fromQuery, matchLocale, type LocaleDetector, type PathPrefixOptions } from './detect';

export interface ValidationTranslation<M, L extends string> {
  /** The translated message of one schema issue (the library's raw issue), or `undefined` to keep it. */
  issue?(issue: unknown, context: { t: Translator<M, L>['t']; locale: L; label: string }): string | undefined;
  /** The translated top-level `message` (default `"<label> validation failed"`). */
  message?(label: string, context: { t: Translator<M, L>['t']; locale: L }): string | undefined;
}

export interface I18nOptions<Ms extends Record<string, Catalog>, D extends keyof Ms & string> {
  /** One catalog per language: the default from `defineMessages`, the others from `defineTranslation`. */
  messages: Ms;
  /** The language used when no detector matches, and for messages a translation lacks. */
  defaultLocale: D;
  /** Tried in order; the first candidate that matches a language wins. Default `[fromAcceptLanguage()]`. */
  detect?: readonly LocaleDetector[];
  /** Named styles for `{x, number, name}` / `{x, date, name}` placeholders. */
  formats?: FormatOptions;
  /** Translates kivin's 400 for invalid input (needs the `onRequest` hook). */
  validation?: ValidationTranslation<Ms[D], keyof Ms & string>;
}

export interface I18n<M extends Catalog, L extends string> {
  readonly locales: readonly L[];
  readonly defaultLocale: L;
  /** The request's language (detected once per request, also for a request the hook rewrote). */
  locale(request: Request): L;
  /** A translator for a language, or for the request's language. */
  translator(target: L | Request): Translator<M, L>;
  /**
   * `defineApplication({ onRequest: [i18n.onRequest] })`: detects the language before routing, routes
   * `/ja/users` as `/users` with `fromPathPrefix()`, and on every route's response sets
   * `Content-Language`, adds the detectors' headers to `Vary` and translates validation errors.
   */
  readonly onRequest: RequestHook;
  /** Token for the request's translator, provided by `provider`. */
  readonly token: InjectionToken<Translator<M, L>>;
  /** A request-scoped provider of `token`: `@Injectable({ deps: [i18n.token] })`. */
  readonly provider: FactoryProvider<Translator<M, L>>;
}

function addVary(headers: Headers, names: readonly string[]) {
  const current = headers.get('vary');
  if (current?.trim() === '*') {
    return;
  }
  const present = new Set((current ?? '').split(',').map((name) => name.trim().toLowerCase()).filter(Boolean));
  const missing = names.filter((name) => !present.has(name.toLowerCase()));
  if (missing.length > 0) {
    headers.set('vary', current ? `${current}, ${missing.join(', ')}` : missing.join(', '));
  }
}

/**
 * ```ts
 * const en = defineMessages({ hello: 'Hello, {name}', items: plural({ one: '{count} item', other: '{count} items' }) });
 * const ja = defineTranslation(en, { hello: 'こんにちは、{name}さん', items: plural({ other: '{count} 件' }) });
 * export const i18n = createI18n({ messages: { en, ja }, defaultLocale: 'en', detect: [fromQuery(), fromAcceptLanguage()] });
 *
 * defineApplication({ ..., onRequest: [i18n.onRequest] });
 * i18n.translator(context.request).t('items', { count: 3 }); // "3 件"
 * ```
 */
export function createI18n<const Ms extends Record<string, Catalog>, D extends keyof Ms & string>(options: I18nOptions<Ms, D>): I18n<Ms[D], keyof Ms & string> {
  type L = keyof Ms & string;
  type M = Ms[D];
  const locales = Object.keys(options.messages) as L[];
  const defaultLocale = options.defaultLocale;
  if (!locales.includes(defaultLocale)) {
    throw new TypeError(`@kivinjs/i18n: defaultLocale "${defaultLocale}" has no catalog in messages`);
  }
  const formats = options.formats ?? {};
  const detectors = options.detect ?? [fromAcceptLanguage()];
  const rewriters = detectors.filter((detector) => detector.rewrite);
  const vary = [...new Set(detectors.flatMap((detector) => (detector.vary ? [detector.vary] : [])))];
  const base = compileCatalog(options.messages[defaultLocale] as Catalog, defaultLocale, formats);
  const catalogs = new Map(locales.map((locale) => [locale, locale === defaultLocale ? base : compileCatalog(options.messages[locale]!, locale, formats, base)]));
  const formatters = new Map(locales.map((locale) => [locale, new Formatter(locale, formats)]));
  const defaultFormatter = formatters.get(defaultLocale)!;

  const translators = new Map<L, Translator<M, L>>();
  const translatorFor = (locale: L): Translator<M, L> => {
    let translator = translators.get(locale);
    if (!translator) {
      const catalog = catalogs.get(locale);
      const formatter = formatters.get(locale);
      if (!catalog || !formatter) {
        throw new TypeError(`@kivinjs/i18n: no catalog for locale "${locale}" (have ${locales.join(', ')})`);
      }
      translator = {
        locale,
        t: ((key: string, params: Record<string, unknown> = {}) => {
          const compiled = catalog.get(key);
          if (compiled) {
            return formatter.render(compiled, params);
          }
          // A translation without this key falls back to the default language as a whole.
          const fallback = base.get(key);
          return fallback ? defaultFormatter.render(fallback, params) : key;
        }) as Translator<M, L>['t'],
        number: (value, numberOptions) => formatter.number(value, numberOptions),
        date: (value, dateOptions) => formatter.date(value, dateOptions),
      };
      translators.set(locale, translator);
    }
    return translator;
  };

  const detected = new WeakMap<Request, L>();
  const detectLocale = (request: Request): L => {
    for (const detector of detectors) {
      const candidate = detector.detect(request, locales);
      const locale = candidate === undefined ? undefined : matchLocale(candidate, locales);
      if (locale !== undefined) {
        return locale;
      }
    }
    return defaultLocale;
  };
  const locale = (request: Request): L => {
    const key = originalRequest(request);
    let found = detected.get(key);
    if (found === undefined) {
      found = detectLocale(key);
      detected.set(key, found);
    }
    return found;
  };

  const translateValidation = options.validation;
  const finish = (request: Request, response: Response): Response | void => {
    const language = locale(request);
    const failure = translateValidation ? getValidationFailure(response) : undefined;
    if (failure && translateValidation) {
      const { t } = translatorFor(language);
      const issues = toValidationIssues(failure.issues).map((issue, index) => ({
        ...issue,
        message: translateValidation.issue?.(failure.issues[index], { t, locale: language, label: failure.label }) ?? issue.message,
      }));
      const message = translateValidation.message?.(failure.label, { t, locale: language }) ?? `${failure.label} validation failed`;
      const headers = new Headers(response.headers);
      headers.delete('content-length');
      headers.set('content-language', language);
      addVary(headers, vary);
      return new Response(JSON.stringify({ message, issues }), { status: response.status, statusText: response.statusText, headers });
    }
    if (response.headers.has('content-language') && vary.length === 0) {
      return;
    }
    try {
      applyHeaders(response.headers, language);
      return;
    } catch {
      // Immutable headers (e.g. a fetched response passed through): answer with a copy.
      const copy = new Response(response.body, response);
      applyHeaders(copy.headers, language);
      return copy;
    }
  };
  const applyHeaders = (headers: Headers, language: L) => {
    if (!headers.has('content-language')) {
      headers.set('content-language', language);
    }
    addVary(headers, vary);
  };

  const onRequest: RequestHook = (request) => {
    // Keyed like `locale()`: an earlier hook may already have rewritten `request`.
    detected.set(originalRequest(request), detectLocale(request));
    afterResponse(request, (response) => finish(request, response));
    for (const detector of rewriters) {
      const rewritten = detector.rewrite!(request, locales);
      if (rewritten) {
        return rewritten;
      }
    }
    return undefined;
  };

  const token = Symbol('@kivinjs/i18n translator') as InjectionToken<Translator<M, L>>;
  return {
    locales,
    defaultLocale,
    locale,
    translator: (target) => translatorFor(typeof target === 'string' ? target : locale(target)),
    onRequest,
    token,
    provider: {
      provide: token,
      scope: 'request',
      useFactory: (container) => translatorFor(locale(container.resolve(RequestContext).request)),
    },
  };
}
