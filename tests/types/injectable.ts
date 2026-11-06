// Compile-time tests for `@Injectable({ deps })`. `bun run check` fails if an expectation breaks.
import { createToken } from '@kivinjs/core';
import { Injectable } from '@kivinjs/decorators';
import { LOGGER, type Logger } from '@kivinjs/logger';

class Repo {
  find() {
    return 'row';
  }
}

class Clock {
  now() {
    return 0;
  }
}

const CONFIG = createToken<{ url: string }>('test.config');
const UNTYPED = Symbol.for('test.untyped');

@Injectable({ deps: [Repo, Clock] })
export class MatchingDeps {
  constructor(readonly repo: Repo, readonly clock: Clock) {}
}

@Injectable({ deps: [CONFIG, LOGGER] })
export class TypedTokens {
  constructor(readonly config: { url: string }, readonly logger: Logger) {}
}

@Injectable({ deps: [UNTYPED] })
export class UntypedTokenIsNotChecked {
  constructor(readonly anything: number) {}
}

@Injectable()
export class NoDeps {}

@Injectable({ deps: [Repo] })
export class OptionalTrailingParameter {
  constructor(readonly repo: Repo, readonly clock?: Clock) {}
}

// @ts-expect-error deps are in the wrong order
@Injectable({ deps: [Clock, Repo] })
export class WrongOrder {
  constructor(readonly repo: Repo, readonly clock: Clock) {}
}

// @ts-expect-error a required constructor parameter has no dep
@Injectable({ deps: [Repo] })
export class MissingDep {
  constructor(readonly repo: Repo, readonly clock: Clock) {}
}

// @ts-expect-error more deps than constructor parameters
@Injectable({ deps: [Repo, Clock] })
export class ExtraDep {
  constructor(readonly repo: Repo) {}
}

// @ts-expect-error a typed token's value does not fit the parameter
@Injectable({ deps: [CONFIG] })
export class WrongTokenType {
  constructor(readonly config: { url: number }) {}
}
