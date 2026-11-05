import { describe, expect, test } from 'bun:test';
import { readQueryObject } from '../src/request-url';
import { normalizeRoutePath } from '../src/runtime/routing';

describe('readQueryObject', () => {
  const cases: Array<[string, Record<string, string> | undefined]> = [
    ['http://x/u?search=Ada', { search: 'Ada' }],
    ['http://x/u?a=1&b=2&a=3', { a: ['1', '3'], b: '2' }],
    ['http://x/u?t=a&t=b&t=c', { t: ['a', 'b', 'c'] }],
    ['http://x/u?', undefined],
    ['http://x/u?#a=1', undefined],
    ['http://x/u', undefined],
    ['http://x/u?&&a', { a: '' }],
    ['http://x/u?a=&=b&c', { a: '', c: '' }],
    ['http://x/u?q=a+b%20c#frag&x=1', { q: 'a b c' }],
    ['/u?k%20e=v', { 'k e': 'v' }],
    ['http://x/u?eq=a=b', { eq: 'a=b' }],
  ];

  for (const [url, expected] of cases) {
    test(url, () => {
      const result = readQueryObject(url);
      expect(result === undefined ? undefined : { ...result }).toEqual(expected);
    });
  }

  test('keys never reach the prototype', () => {
    const result = readQueryObject('http://x/u?__proto__=x&constructor=y')!;
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(result.__proto__).toBe('x');
    expect(result.constructor).toBe('y');
  });
});

describe('normalizeRoutePath', () => {
  test.each([
    ['/', '/'],
    ['/users', '/users'],
    ['/users/', '/users'],
    ['users', '/users'],
    ['', '/'],
    ['//', '/'],
  ])('%p -> %p', (input, expected) => {
    expect(normalizeRoutePath(input)).toBe(expected);
  });
});
