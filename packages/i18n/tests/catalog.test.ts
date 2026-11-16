import { createI18n, defineMessages, defineTranslation, fromAcceptLanguage, fromCookie, fromPathPrefix, fromQuery, matchLocale, plural } from '@kivinjs/i18n';
import { describe, expect, test } from 'bun:test';

const en = defineMessages({
  hello: 'Hello, {name}!',
  plain: 'Nothing to fill',
  cart: {
    items: plural({ zero: 'Your cart is empty', one: '{count} item', other: '{count} items' }),
    total: 'Total: {amount, number, price}',
  },
  shipped: 'Shipped on {when, date, long}',
  ratio: '{value, number, percent} done',
  onlyEnglish: 'English only, {name}',
});

const ja = defineTranslation(en, {
  hello: 'こんにちは、{name}さん',
  plain: '埋めるものなし',
  cart: {
    items: plural({ zero: 'カートは空です', other: '{count} 点' }),
    total: '合計: {amount, number, price}',
  },
  shipped: '{when, date, long}に発送',
  ratio: '{value, number, percent} 完了',
  onlyEnglish: '英語のみ、{name}',
});

const i18n = createI18n({
  messages: { en, ja },
  defaultLocale: 'en',
  formats: { number: { price: { style: 'currency', currency: 'JPY' } } },
});

describe('translator', () => {
  test('given a message with a placeholder, when translated, then the param is filled in per language', () => {
    expect(i18n.translator('en').t('hello', { name: 'Ada' })).toBe('Hello, Ada!');
    expect(i18n.translator('ja').t('hello', { name: 'Ada' })).toBe('こんにちは、Adaさん');
    expect(i18n.translator('ja').t('plain')).toBe('埋めるものなし');
  });

  test('given a plural, when translated, then Intl.PluralRules picks the form and zero has its own', () => {
    const t = i18n.translator('en').t;
    expect(t('cart.items', { count: 0 })).toBe('Your cart is empty');
    expect(t('cart.items', { count: 1 })).toBe('1 item');
    expect(t('cart.items', { count: 1234 })).toBe('1,234 items');
    expect(i18n.translator('ja').t('cart.items', { count: 1 })).toBe('1 点');
  });

  test('given number and date placeholders, when translated, then Intl formats them for the language with named styles', () => {
    const when = new Date(Date.UTC(2026, 10, 16, 12));
    expect(i18n.translator('en').t('cart.total', { amount: 1500 })).toBe('Total: ¥1,500');
    expect(i18n.translator('ja').t('cart.total', { amount: 1500 })).toBe(`合計: ${new Intl.NumberFormat('ja', { style: 'currency', currency: 'JPY' }).format(1500)}`);
    expect(i18n.translator('ja').t('shipped', { when })).toBe(`${new Intl.DateTimeFormat('ja', { dateStyle: 'long' }).format(when)}に発送`);
    expect(i18n.translator('en').t('ratio', { value: 0.5 })).toBe('50% done');
  });

  test('given number and date helpers, when called, then they format for the language', () => {
    expect(i18n.translator('en').number(1234.5)).toBe('1,234.5');
    expect(i18n.translator('ja').date(0, { timeZone: 'UTC', year: 'numeric' })).toBe('1970年');
  });

  test('given a missing param, when translated, then the placeholder stays visible', () => {
    expect(i18n.translator('en').t('hello', {} as { name: string })).toBe('Hello, {name}!');
  });

  test('given the types, when a key or a param is wrong, then it does not compile', () => {
    const t = i18n.translator('en').t;
    // @ts-expect-error unknown key
    t('nope');
    // @ts-expect-error missing params
    t('hello');
    // @ts-expect-error wrong param name
    t('hello', { nam: 'x' });
    // @ts-expect-error a number placeholder takes a number
    t('cart.total', { amount: '1' });
    // @ts-expect-error a plural takes a numeric count
    t('cart.items', { count: '1' });
    // @ts-expect-error a group is not a message
    t('cart');
    // @ts-expect-error no such locale
    expect(() => i18n.translator('fr')).toThrow(/no catalog for locale "fr"/);
    expect(t('plain')).toBe('Nothing to fill');
  });

  test('given a translation, when it misses or adds a key or changes a kind, then it does not compile', () => {
    // @ts-expect-error missing key
    defineTranslation(defineMessages({ a: 'A', b: 'B' }), { a: 'あ' });
    // @ts-expect-error unknown key
    defineTranslation(defineMessages({ a: 'A' }), { a: 'あ', extra: 'x' });
    // @ts-expect-error a plural must stay a plural
    defineTranslation(defineMessages({ n: plural({ other: '{count}' }) }), { n: '{count}' });
    expect(true).toBe(true);
  });
});

describe('createI18n checks the catalogs at startup', () => {
  test('given a translation using a param the default message does not take, when created, then it throws', () => {
    const base = defineMessages({ hello: 'Hello, {name}' });
    expect(() => createI18n({ messages: { en: base, ja: defineTranslation(base, { hello: '{nickname}' }) }, defaultLocale: 'en' })).toThrow(/\{nickname\}/);
  });

  test('given an unknown named style or a malformed placeholder, when created, then it throws', () => {
    expect(() => createI18n({ messages: { en: defineMessages({ a: '{x, number, money}' }) }, defaultLocale: 'en' })).toThrow(/unknown number style "money"/);
    expect(() => createI18n({ messages: { en: defineMessages({ a: '{x, color}' }) }, defaultLocale: 'en' })).toThrow(/invalid placeholder/);
  });

  test('given a key with a dot or a defaultLocale without a catalog, when created, then it throws', () => {
    expect(() => createI18n({ messages: { en: { 'a.b': 'x' } }, defaultLocale: 'en' })).toThrow(/contains "\."/);
    expect(() => createI18n({ messages: { en: defineMessages({ a: 'x' }) }, defaultLocale: 'fr' as 'en' })).toThrow(/defaultLocale "fr"/);
  });

  test('given an untyped translation lacking a key, when translated, then the default language answers', () => {
    const base = defineMessages({ a: 'A {n}', b: 'B' });
    const partial = createI18n({ messages: { en: base, ja: { b: 'ビー' } as never }, defaultLocale: 'en' });
    expect(partial.translator('ja').t('a', { n: 1 })).toBe('A 1');
    expect(partial.translator('ja').t('b')).toBe('ビー');
  });
});

const request = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });

describe('detectors', () => {
  const locales = ['en-US', 'ja', 'fr'] as const;

  test('given candidates, when matched, then exact wins and otherwise the same language matches', () => {
    expect(matchLocale('JA', locales)).toBe('ja');
    expect(matchLocale('ja-JP', locales)).toBe('ja');
    expect(matchLocale('en', locales)).toBe('en-US');
    expect(matchLocale('de', locales)).toBeUndefined();
    expect(matchLocale(' ', locales)).toBeUndefined();
  });

  test('given each source, when detected, then it reads its own part of the request', () => {
    expect(fromQuery().detect(request('http://x/?lang=ja'), locales)).toBe('ja');
    expect(fromQuery('hl').detect(request('http://x/?lang=ja'), locales)).toBeUndefined();
    expect(fromCookie().detect(request('http://x/', { cookie: 'a=1; lang=fr' }), locales)).toBe('fr');
    expect(fromAcceptLanguage().detect(request('http://x/', { 'accept-language': 'de, ja;q=0.8, fr;q=0.5' }), locales)).toBe('ja');
    expect(fromAcceptLanguage().detect(request('http://x/'), locales)).toBeUndefined();
    expect(fromPathPrefix().detect(request('http://x/ja/users'), locales)).toBe('ja');
    expect(fromPathPrefix().detect(request('http://x/jam/users'), locales)).toBeUndefined();
  });

  test('given a path prefix, when rewritten, then the prefix is stripped and the query kept', () => {
    expect(fromPathPrefix().rewrite!(request('http://x/ja/users?page=2'), locales)?.url).toBe('http://x/users?page=2');
    expect(fromPathPrefix().rewrite!(request('http://x/ja'), locales)?.url).toBe('http://x/');
    expect(fromPathPrefix().rewrite!(request('http://x/users'), locales)).toBeUndefined();
    expect(fromPathPrefix({ strip: false }).rewrite).toBeUndefined();
  });

  test('given ordered detectors, when the first has no match, then the next one decides, else the default', () => {
    const ordered = createI18n({ messages: { en: defineMessages({ a: 'a' }), ja: { a: 'あ' }, fr: { a: 'à' } }, defaultLocale: 'en', detect: [fromQuery(), fromCookie(), fromAcceptLanguage()] });
    expect(ordered.locale(request('http://x/?lang=de', { cookie: 'lang=fr', 'accept-language': 'ja' }))).toBe('fr');
    expect(ordered.locale(request('http://x/?lang=ja-JP', { cookie: 'lang=fr' }))).toBe('ja');
    expect(ordered.locale(request('http://x/', { 'accept-language': 'ja' }))).toBe('ja');
    expect(ordered.locale(request('http://x/'))).toBe('en');
  });
});
