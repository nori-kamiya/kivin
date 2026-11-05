import {
    getInjectableMetadata,
    type ClassProvider,
    type ContainerLike,
    type FactoryProvider,
    type ProviderDefinition,
    type ProviderScope,
    type ValueProvider,
} from './metadata';
import type { Constructor, Token } from './types';

function isClassProvider<T>(provider: ProviderDefinition<T>): provider is ClassProvider<T> {
  return typeof provider === 'object' && provider !== null && 'useClass' in provider;
}

function isFactoryProvider<T>(provider: ProviderDefinition<T>): provider is FactoryProvider<T> {
  return typeof provider === 'object' && provider !== null && 'useFactory' in provider;
}

function isValueProvider<T>(provider: ProviderDefinition<T>): provider is ValueProvider<T> {
  return typeof provider === 'object' && provider !== null && 'useValue' in provider;
}

function getProviderScope(provider: ProviderDefinition): ProviderScope {
  if (typeof provider === 'function') {
    return 'singleton';
  }

  return provider.scope ?? 'singleton';
}

// Tokens currently being created, outermost first. Construction is synchronous, so one shared stack
// is enough (and it spans root and request containers).
const resolutionStack: Token[] = [];

function describe(token: Token) {
  return String(typeof token === 'function' ? token.name : token);
}

export class Container implements ContainerLike {
  private readonly providers = new Map<Token, ProviderDefinition>();
  private readonly singletons = new Map<Token, unknown>();
  private readonly requestScoped = new Map<Token, unknown>();
  /** Singletons in creation order, for shutdown hooks. Only touched when a singleton is first created. */
  private readonly singletonOrder: unknown[] = [];

  constructor(private readonly parent?: Container) {}

  register(provider: ProviderDefinition) {
    if (typeof provider === 'function') {
      this.providers.set(provider, { provide: provider, useClass: provider });
      return;
    }

    this.providers.set(provider.provide, provider);
  }
  
  hasLocalProvider(token: Token) {
    return this.providers.has(token);
  }
  
  getProviderScope(token: Token): ProviderScope | undefined {
    const provider = this.lookupProvider(token);
    return provider ? getProviderScope(provider) : undefined;
  }

  /** Singleton instances created so far, oldest first. */
  singletonInstances(): readonly unknown[] {
    return this.singletonOrder;
  }

  createRequestContainer() {
    return new Container(this);
  }

  resolve<T>(token: Token<T>): T {
    const provider = this.lookupProvider(token);
    if (!provider) {
      const requiredBy = resolutionStack.length > 0 ? ` (required by ${[...resolutionStack].reverse().map(describe).join(' <- ')})` : '';
      throw new Error(`Provider not found: ${describe(token)}${requiredBy}`);
    }

    const scope = getProviderScope(provider);
    if (scope === 'singleton') {
      return this.resolveSingleton(token, provider) as T;
    }

    if (this.requestScoped.has(token)) {
      return this.requestScoped.get(token) as T;
    }

    const instance = this.instantiateTracked(token, provider);
    this.requestScoped.set(token, instance);
    return instance as T;
  }

  private resolveSingleton<T>(token: Token<T>, provider: ProviderDefinition<T>) {
    const owner = this.parent ? this.parent.getSingletonOwner(token) : this;
    if (owner.singletons.has(token)) {
      return owner.singletons.get(token) as T;
    }

    const instance = owner.instantiateTracked(token, provider);
    owner.singletons.set(token, instance);
    owner.singletonOrder.push(instance);
    return instance as T;
  }

  private getSingletonOwner(token: Token): Container {
    if (this.providers.has(token) || !this.parent) {
      return this;
    }

    return this.parent.getSingletonOwner(token);
  }

  private lookupProvider<T>(token: Token<T>): ProviderDefinition<T> | undefined {
    const localProvider = this.providers.get(token);
    if (localProvider) {
      return localProvider as ProviderDefinition<T>;
    }

    return this.parent?.lookupProvider(token);
  }

  /**
   * Creates an instance while tracking the chain being resolved, so a cycle is reported as
   * `A -> B -> A` instead of a stack overflow. Only runs on creation; cached instances skip it.
   */
  private instantiateTracked<T>(token: Token<T>, provider: ProviderDefinition<T>): T {
    if (resolutionStack.includes(token)) {
      const cycle = [...resolutionStack.slice(resolutionStack.indexOf(token)), token].map(describe).join(' -> ');
      throw new Error(`Circular dependency: ${cycle}`);
    }
    resolutionStack.push(token);
    try {
      return this.instantiateProvider(provider);
    } finally {
      resolutionStack.pop();
    }
  }

  private instantiateProvider<T>(provider: ProviderDefinition<T>) {
    let instance: unknown;

    if (isValueProvider(provider)) {
      instance = provider.useValue;
    } else if (isFactoryProvider(provider)) {
      instance = provider.useFactory(this);
    } else if (isClassProvider(provider)) {
      instance = this.instantiate(provider.useClass);
    } else {
      instance = this.instantiate(provider as Constructor);
    }

    return instance as T;
  }

  private instantiate<T>(constructor: Constructor<T>): T {
    const metadata = getInjectableMetadata(constructor);
    const deps = metadata.deps.map((token) => this.resolve(token));
    return new constructor(...(deps as never[]));
  }
}
