// @kivinjs/config: environment variables validated by a schema at startup, typed, and injectable.
import { toValidationIssues, type InferSchemaOutput, type InjectionToken, type SchemaAdapter } from '@kivinjs/core';

export type EnvSource = Record<string, string | undefined>;

export interface LoadEnvOptions<TSchema> {
  /**
   * Validates with this adapter (`createValibotAdapter()`, `createStandardSchemaAdapter()`). Without
   * one, a Standard Schema (Valibot, Zod, ArkType, …) is validated through its `~standard` interface.
   */
  adapter?: SchemaAdapter<TSchema>;
  /** Variables to read. Default `process.env` (Bun loads `.env` files into it). */
  source?: EnvSource;
  /**
   * Only variables starting with this prefix are read, with the prefix removed (`APP_PORT` → `PORT`),
   * so the schema names stay short and unrelated variables never reach it.
   */
  prefix?: string;
}

export interface EnvIssue {
  /** Variable name (with the prefix), or `''` for a problem with the whole object. */
  variable: string;
  message: string;
}

/** Thrown by `loadEnv` with every invalid variable; values are never included in the message. */
export class EnvValidationError extends Error {
  constructor(readonly issues: EnvIssue[]) {
    super(`Invalid environment variables:\n${issues.map((issue) => `  - ${issue.variable || '(env)'}: ${issue.message}`).join('\n')}`);
    this.name = 'EnvValidationError';
  }
}

interface StandardSchemaV1 {
  readonly '~standard': {
    readonly validate: (value: unknown) => StandardResult | Promise<StandardResult>;
  };
}

type StandardResult = { value: unknown; issues?: undefined } | { issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<PropertyKey | { key: PropertyKey }> }> };

function isStandardSchema(schema: unknown): schema is StandardSchemaV1 {
  return typeof (schema as StandardSchemaV1 | null)?.['~standard']?.validate === 'function';
}

function selectVariables(source: EnvSource, prefix: string | undefined): EnvSource {
  const selected: EnvSource = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) {
      continue;
    }
    if (prefix === undefined) {
      selected[name] = value;
    } else if (name.startsWith(prefix) && name.length > prefix.length) {
      selected[name.slice(prefix.length)] = value;
    }
  }
  return selected;
}

/** Replaces the variable's value wherever a validator echoed it into a message (they often do). */
function redact(message: string, value: string | undefined) {
  return value && value.length > 0 ? message.split(value).join('***') : message;
}

/**
 * Reads and validates environment variables once, at startup. Returns the schema's output (strings
 * converted, defaults applied) or throws `EnvValidationError` naming every invalid variable.
 *
 * ```ts
 * const Env = v.object({
 *   PORT: v.optional(v.pipe(v.string(), v.transform(Number), v.integer()), '3000'),
 *   DATABASE_URL: v.pipe(v.string(), v.url()),
 * });
 * export const env = loadEnv(Env);   // { PORT: number; DATABASE_URL: string }
 * ```
 */
export function loadEnv<TSchema>(schema: TSchema, options: LoadEnvOptions<TSchema> = {}): InferSchemaOutput<TSchema> {
  const variables = selectVariables(options.source ?? process.env, options.prefix);
  const prefix = options.prefix ?? '';
  const toIssues = (issues: Array<{ path: Array<string | number>; message: string }>): EnvIssue[] => issues.map((issue) => {
    const name = issue.path.length > 0 ? String(issue.path[0]) : '';
    return { variable: name ? `${prefix}${name}` : '', message: redact(issue.message, name ? variables[name] : undefined) };
  });

  if (options.adapter) {
    const result = options.adapter.parse<InferSchemaOutput<TSchema>>(schema, variables);
    if (!result.success) {
      throw new EnvValidationError(toIssues(toValidationIssues(result.issues)));
    }
    return result.output;
  }

  if (!isStandardSchema(schema)) {
    throw new TypeError('loadEnv: pass a Standard Schema (Valibot, Zod, ArkType, …) or options.adapter');
  }
  const result = schema['~standard'].validate(variables);
  if (result instanceof Promise) {
    throw new TypeError('loadEnv: the schema validates asynchronously; environment validation must be synchronous');
  }
  if (result.issues) {
    throw new EnvValidationError(toIssues(toValidationIssues(result.issues)));
  }
  return result.value as InferSchemaOutput<TSchema>;
}

/**
 * A provider for `token` whose value is the validated environment, validated when first injected
 * (resolve it at startup, e.g. `app.get(token)`, to fail fast).
 *
 * ```ts
 * export const ENV = createToken<InferSchemaOutput<typeof Env>>('app.env');
 * defineModule({ providers: [envProvider(ENV, Env)], ... });
 * @Injectable({ deps: [ENV] }) class Mailer { constructor(private readonly env: TokenValue<typeof ENV>) {} }
 * ```
 */
export function envProvider<TSchema>(token: InjectionToken<InferSchemaOutput<TSchema>>, schema: TSchema, options: LoadEnvOptions<TSchema> = {}) {
  return { provide: token, useFactory: () => loadEnv(schema, options) };
}
