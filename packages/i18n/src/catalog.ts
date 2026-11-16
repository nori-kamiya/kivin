// Message catalogs: their types (keys and interpolation params derived from the default catalog) and
// the runtime that compiles and formats them with Intl.

export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';
export type PluralForms = { readonly other: string } & { readonly [C in Exclude<PluralCategory, 'other'>]?: string };

const PLURAL = Symbol('@kivinjs/i18n plural');

/** A message with plural forms, chosen by its `count` param. Build it with `plural(...)`. */
export interface Plural<F extends PluralForms = PluralForms> {
  readonly [PLURAL]: F;
}

export interface Catalog {
  readonly [key: string]: string | Plural | Catalog;
}

/**
 * Plural forms, selected by `Intl.PluralRules` for the `count` param (`zero` also covers 0 in every
 * language): `plural({ one: '{count} item', other: '{count} items' })`.
 */
export function plural<const F extends PluralForms>(forms: F): Plural<F> {
  return { [PLURAL]: forms };
}

/** The default language's catalog; its keys and placeholders type every `t(...)` call. */
export function defineMessages<const M extends Catalog>(messages: M): M {
  return messages;
}

/** Another language's catalog for `base`: the same keys, strings stay strings and plurals plurals. */
export type Translation<M> = {
  readonly [K in keyof M]: M[K] extends string ? string : M[K] extends Plural ? Plural : Translation<M[K]>;
};

/** A translation of `base`, type-checked against it (missing or unknown keys are errors). */
export function defineTranslation<M extends Catalog>(_base: M, translation: Translation<M>): Translation<M> {
  return translation;
}

export type MessageKey<M, P extends string = ''> = {
  [K in keyof M & string]: M[K] extends string | Plural ? `${P}${K}` : MessageKey<M[K], `${P}${K}.`>;
}[keyof M & string];

type MessageAt<M, K extends string> = K extends `${infer H}.${infer R}`
  ? H extends keyof M ? MessageAt<M[H], R> : never
  : K extends keyof M ? M[K] : never;

type Trim<S extends string> = S extends ` ${infer R}` ? Trim<R> : S extends `${infer R} ` ? Trim<R> : S;
type PlaceholderName<P extends string> = P extends `${infer N},${string}` ? Trim<N> : Trim<P>;
type PlaceholderType<P extends string> = P extends `${string},${infer F}`
  ? Trim<F> extends `number${string}` ? number : Trim<F> extends `date${string}` | `time${string}` ? Date | number : string | number
  : string | number;
type TemplateParams<S extends string> = S extends `${string}{${infer P}}${infer Rest}`
  ? { [K in PlaceholderName<P>]: PlaceholderType<P> } & TemplateParams<Rest>
  : unknown;
type UnionToIntersection<U> = (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void ? I : never;
type Flatten<T> = { [K in keyof T]: T[K] };

export type MessageParams<T> = T extends string
  ? Flatten<TemplateParams<T>>
  : T extends Plural<infer F> ? Flatten<UnionToIntersection<TemplateParams<F[keyof F] & string>> & { count: number }> : never;

/** `t`'s arguments after the key: none for a message without placeholders, else its params. */
export type MessageArgs<M, K extends string> = keyof MessageParams<MessageAt<M, K>> extends never
  ? [params?: Record<string, never>]
  : [params: MessageParams<MessageAt<M, K>>];

export interface Translator<M = Catalog, L extends string = string> {
  /** The language this translator formats for. */
  readonly locale: L;
  /** The message at `key` (dot-separated for nested groups) with its placeholders filled in. */
  t<K extends MessageKey<M>>(key: K, ...args: MessageArgs<M, K>): string;
  /** `Intl.NumberFormat` for this language. */
  number(value: number | bigint, options?: Intl.NumberFormatOptions): string;
  /** `Intl.DateTimeFormat` for this language. */
  date(value: Date | number, options?: Intl.DateTimeFormatOptions): string;
}

export interface FormatOptions {
  /** Named number styles for `{x, number, name}`; `integer` and `percent` are built in. */
  number?: Record<string, Intl.NumberFormatOptions>;
  /** Named styles for `{x, date, name}` / `{x, time, name}`; `short`, `medium`, `long` and `full` are built in. */
  date?: Record<string, Intl.DateTimeFormatOptions>;
}

// ---- runtime ----

type Kind = 'number' | 'date' | 'time' | undefined;
interface Placeholder {
  name: string;
  kind: Kind;
  style: string | undefined;
}
type Part = string | Placeholder;
type Compiled = { kind: 'text'; parts: Part[] } | { kind: 'plural'; forms: Partial<Record<PluralCategory, Part[]>> };

const PLACEHOLDER = /\{([^{}]*)\}/g;
const SPEC = /^\s*([A-Za-z_$][\w$]*)\s*(?:,\s*(number|date|time)\s*(?:,\s*([\w-]+)\s*)?)?$/;
const BUILTIN_NUMBER: Record<string, Intl.NumberFormatOptions> = { integer: { maximumFractionDigits: 0 }, percent: { style: 'percent' } };
const BUILTIN_DATE_STYLES = new Set(['short', 'medium', 'long', 'full']);

function isPlural(value: unknown): value is Plural {
  return typeof value === 'object' && value !== null && PLURAL in value;
}

function compileTemplate(template: string, where: string, formats: FormatOptions): Part[] {
  const parts: Part[] = [];
  let last = 0;
  for (const match of template.matchAll(PLACEHOLDER)) {
    const spec = SPEC.exec(match[1]!);
    if (!spec) {
      throw new TypeError(`@kivinjs/i18n: ${where}: invalid placeholder ${match[0]} (use {name}, {name, number}, {name, date} or {name, time}, with an optional style)`);
    }
    const [, name, kind, style] = spec as unknown as [string, string, Kind, string | undefined];
    if (style !== undefined) {
      const known = kind === 'number' ? style in BUILTIN_NUMBER || style in (formats.number ?? {}) : BUILTIN_DATE_STYLES.has(style) || style in (formats.date ?? {});
      if (!known) {
        throw new TypeError(`@kivinjs/i18n: ${where}: unknown ${kind} style "${style}" (add it to formats.${kind === 'number' ? 'number' : 'date'})`);
      }
    }
    if (match.index > last) {
      parts.push(template.slice(last, match.index));
    }
    parts.push({ name, kind, style });
    last = match.index + match[0].length;
  }
  if (last < template.length) {
    parts.push(template.slice(last));
  }
  return parts;
}

function names(compiled: Compiled): Set<string> {
  const lists = compiled.kind === 'text' ? [compiled.parts] : Object.values(compiled.forms);
  const result = new Set<string>(compiled.kind === 'plural' ? ['count'] : []);
  for (const parts of lists) {
    for (const part of parts ?? []) {
      if (typeof part !== 'string') {
        result.add(part.name);
      }
    }
  }
  return result;
}

/** Flattens and compiles a catalog; with `base`, also checks it is a faithful translation of it. */
export function compileCatalog(catalog: Catalog, locale: string, formats: FormatOptions, base?: Map<string, Compiled>): Map<string, Compiled> {
  const result = new Map<string, Compiled>();
  const visit = (node: Catalog, prefix: string) => {
    for (const [key, value] of Object.entries(node)) {
      if (key.includes('.')) {
        throw new TypeError(`@kivinjs/i18n: ${locale}: message key "${prefix}${key}" contains "." (nest groups instead)`);
      }
      const path = `${prefix}${key}`;
      const where = `${locale} "${path}"`;
      let compiled: Compiled;
      if (typeof value === 'string') {
        compiled = { kind: 'text', parts: compileTemplate(value, where, formats) };
      } else if (isPlural(value)) {
        const forms: Partial<Record<PluralCategory, Part[]>> = {};
        for (const [category, template] of Object.entries(value[PLURAL])) {
          forms[category as PluralCategory] = compileTemplate(template as string, `${where} (${category})`, formats);
        }
        if (!forms.other) {
          throw new TypeError(`@kivinjs/i18n: ${where}: a plural needs an "other" form`);
        }
        compiled = { kind: 'plural', forms };
      } else {
        visit(value, `${path}.`);
        continue;
      }
      if (base) {
        const original = base.get(path);
        if (!original) {
          throw new TypeError(`@kivinjs/i18n: ${where}: not in the default catalog`);
        }
        if (original.kind !== compiled.kind) {
          throw new TypeError(`@kivinjs/i18n: ${where}: is ${compiled.kind === 'plural' ? 'a plural' : 'text'} but the default catalog has ${original.kind === 'plural' ? 'a plural' : 'text'}`);
        }
        const allowed = names(original);
        const unknown = [...names(compiled)].filter((name) => !allowed.has(name));
        if (unknown.length > 0) {
          throw new TypeError(`@kivinjs/i18n: ${where}: uses {${unknown.join('}, {')}}, which the default catalog's message does not take`);
        }
      }
      result.set(path, compiled);
    }
  };
  visit(catalog, '');
  return result;
}

export class Formatter {
  private readonly numberFormats = new Map<string, Intl.NumberFormat>();
  private readonly dateFormats = new Map<string, Intl.DateTimeFormat>();
  private pluralRules: Intl.PluralRules | undefined;

  constructor(readonly locale: string, private readonly formats: FormatOptions) {}

  number(value: number | bigint, options?: Intl.NumberFormatOptions, cacheKey?: string): string {
    if (cacheKey === undefined) {
      return new Intl.NumberFormat(this.locale, options).format(value);
    }
    let format = this.numberFormats.get(cacheKey);
    if (!format) {
      format = new Intl.NumberFormat(this.locale, options);
      this.numberFormats.set(cacheKey, format);
    }
    return format.format(value);
  }

  date(value: Date | number, options?: Intl.DateTimeFormatOptions, cacheKey?: string): string {
    if (cacheKey === undefined) {
      return new Intl.DateTimeFormat(this.locale, options).format(value);
    }
    let format = this.dateFormats.get(cacheKey);
    if (!format) {
      format = new Intl.DateTimeFormat(this.locale, options);
      this.dateFormats.set(cacheKey, format);
    }
    return format.format(value);
  }

  render(compiled: Compiled, params: Record<string, unknown>): string {
    if (compiled.kind === 'text') {
      return this.fill(compiled.parts, params);
    }
    const count = Number(params.count);
    this.pluralRules ??= new Intl.PluralRules(this.locale);
    const category = count === 0 && compiled.forms.zero ? 'zero' : this.pluralRules.select(count);
    return this.fill(compiled.forms[category] ?? compiled.forms.other!, params);
  }

  private fill(parts: Part[], params: Record<string, unknown>): string {
    let text = '';
    for (const part of parts) {
      if (typeof part === 'string') {
        text += part;
        continue;
      }
      const value = params[part.name];
      if (value === undefined || value === null) {
        text += `{${part.name}}`;
      } else if (part.kind === 'date' || part.kind === 'time') {
        text += this.date(value as Date | number, this.dateOptions(part.kind, part.style), `${part.kind}:${part.style ?? ''}`);
      } else if (part.kind === 'number' || typeof value === 'number' || typeof value === 'bigint') {
        const options = part.style === undefined ? undefined : this.formats.number?.[part.style] ?? BUILTIN_NUMBER[part.style];
        text += this.number(value as number, options, `number:${part.style ?? ''}`);
      } else {
        text += String(value);
      }
    }
    return text;
  }

  private dateOptions(kind: 'date' | 'time', style: string | undefined): Intl.DateTimeFormatOptions {
    if (style !== undefined && this.formats.date?.[style]) {
      return this.formats.date[style];
    }
    const named = (style ?? (kind === 'date' ? 'medium' : 'short')) as Intl.DateTimeFormatOptions['dateStyle'];
    return kind === 'date' ? { dateStyle: named } : { timeStyle: named };
  }
}
