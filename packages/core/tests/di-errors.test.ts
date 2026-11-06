import { Container, setInjectableMetadata } from '@kivinjs/core';
import { describe, expect, test } from 'bun:test';

class A {
  constructor(readonly b: unknown) {}
}
class B {
  constructor(readonly c: unknown) {}
}
class C {
  constructor(readonly a: unknown) {}
}
setInjectableMetadata(A, { deps: [B] });
setInjectableMetadata(B, { deps: [C] });
setInjectableMetadata(C, { deps: [A] });

class Missing {}
class Repo {
  constructor(readonly missing: unknown) {}
}
class Service {
  constructor(readonly repo: unknown) {}
}
setInjectableMetadata(Repo, { deps: [Missing] });
setInjectableMetadata(Service, { deps: [Repo] });

describe('dependency resolution errors', () => {
  test('a cycle names the chain instead of overflowing the stack', () => {
    const container = new Container();
    for (const provider of [A, B, C]) {
      container.register(provider);
    }
    expect(() => container.resolve(A)).toThrow('Circular dependency: A -> B -> C -> A');
    // The failed attempt leaves no stale state behind.
    expect(() => container.resolve(B)).toThrow('Circular dependency: B -> C -> A -> B');
  });

  test('a factory that resolves itself is reported as a cycle', () => {
    const container = new Container();
    const SELF = Symbol.for('test.self');
    container.register({ provide: SELF, useFactory: (resolver) => resolver.resolve(SELF) });
    expect(() => container.resolve(SELF)).toThrow('Circular dependency: Symbol(test.self) -> Symbol(test.self)');
  });

  test('a missing provider names who required it', () => {
    const container = new Container();
    container.register(Service);
    container.register(Repo);
    expect(() => container.resolve(Service)).toThrow('Provider not found: Missing (required by Repo <- Service)');
    expect(() => container.resolve(Missing)).toThrow(/^Provider not found: Missing$/);
  });

  test('resolution still works normally after errors', () => {
    const container = new Container();
    class Leaf {}
    class Root {
      constructor(readonly leaf: Leaf) {}
    }
    setInjectableMetadata(Root, { deps: [Leaf] });
    container.register(Leaf);
    container.register(Root);
    expect(container.resolve(Root).leaf).toBeInstanceOf(Leaf);
    expect(container.resolve(Root)).toBe(container.resolve(Root));
  });
});
