import { accepts, acceptsEncoding, acceptsLanguage, acceptsType, negotiate, parseAcceptHeader } from '@kivin/http';
import { describe, expect, test } from 'bun:test';

const request = (headers: Record<string, string>) => new Request('http://localhost/', { headers });

describe('parseAcceptHeader', () => {
  test('values, q and parameters; malformed q counts as 0', () => {
    expect(parseAcceptHeader('text/html;level=1, application/json;q=0.5, */*;q=x, , gzip;Q="0.8"')).toEqual([
      { value: 'text/html', q: 1, params: { level: '1' } },
      { value: 'application/json', q: 0.5, params: {} },
      { value: '*/*', q: 0, params: {} },
      { value: 'gzip', q: 0.8, params: {} },
    ]);
    expect(parseAcceptHeader(null)).toEqual([]);
    expect(parseAcceptHeader('a;q=1.5, b;q=-1, c;q=0.1234')).toEqual([
      { value: 'a', q: 0, params: {} },
      { value: 'b', q: 0, params: {} },
      { value: 'c', q: 0, params: {} },
    ]);
  });
});

describe('acceptsType (Accept)', () => {
  test('q decides, then specificity, then client order', () => {
    expect(acceptsType(request({ accept: 'text/html;q=0.8, application/json' }), ['text/html', 'application/json'])).toBe('application/json');
    expect(acceptsType(request({ accept: 'text/*, text/html' }), ['text/plain', 'text/html'])).toBe('text/html');
    expect(acceptsType(request({ accept: 'application/json, text/html' }), ['text/html', 'application/json'])).toBe('application/json');
  });

  test('wildcards and exclusions', () => {
    expect(acceptsType(request({ accept: '*/*' }), ['application/json', 'text/html'])).toBe('application/json');
    expect(acceptsType(request({ accept: 'text/*' }), ['application/json', 'text/csv'])).toBe('text/csv');
    // The most specific range sets the q: text/html is refused despite */*.
    expect(acceptsType(request({ accept: 'text/html;q=0, */*' }), ['text/html'])).toBeUndefined();
    expect(acceptsType(request({ accept: 'image/png' }), ['application/json'])).toBeUndefined();
    expect(acceptsType(request({ accept: 'image/png' }), ['application/json'], 'application/json')).toBe('application/json');
  });

  test('no header: anything goes (the first supported)', () => {
    expect(acceptsType(request({}), ['application/json', 'text/html'])).toBe('application/json');
  });
});

describe('acceptsLanguage (Accept-Language)', () => {
  test('exact and prefix matches both ways, by q', () => {
    expect(acceptsLanguage(request({ 'accept-language': 'ja-JP,ja;q=0.9,en;q=0.8' }), ['en', 'ja'])).toBe('ja');
    expect(acceptsLanguage(request({ 'accept-language': 'en' }), ['ja', 'en-US'])).toBe('en-US');
    expect(acceptsLanguage(request({ 'accept-language': 'fr-CA, en;q=0.5' }), ['fr', 'en'])).toBe('fr');
    expect(acceptsLanguage(request({ 'accept-language': 'de' }), ['en', 'ja'])).toBeUndefined();
    expect(acceptsLanguage(request({ 'accept-language': 'de, *;q=0.1' }), ['en', 'ja'])).toBe('en');
    expect(acceptsLanguage(request({ 'accept-language': 'EN-us' }), ['en-US'])).toBe('en-US');
  });
});

describe('encodings', () => {
  test('equal q: the server order wins (browsers list gzip before br)', () => {
    expect(negotiate('accept-encoding', 'gzip, deflate, br, zstd', ['br', 'gzip'])).toBe('br');
    expect(negotiate('accept-encoding', 'br;q=0.5, gzip', ['br', 'gzip'])).toBe('gzip');
  });

  test('explicit q=0 beats *, empty header means identity only', () => {
    expect(acceptsEncoding('gzip;q=0, *', 'gzip')).toBe(false);
    expect(acceptsEncoding('gzip;q=0, *', 'br')).toBe(true);
    expect(acceptsEncoding('', 'gzip')).toBe(false);
    expect(negotiate('accept-encoding', '', ['gzip', 'identity'])).toBe('identity');
    expect(accepts(request({ 'accept-encoding': 'deflate' }), 'accept-encoding', ['br', 'gzip'], 'identity' as never)).toBe('identity');
  });
});
