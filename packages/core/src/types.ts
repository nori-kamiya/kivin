export type Constructor<T = unknown> = new (...args: never[]) => T;
export type Token<T = unknown> = Constructor<T> | string | symbol;
export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

export interface ParseSuccess<TOutput> {
  success: true;
  output: TOutput;
}

export interface ParseFailure {
  success: false;
  issues: unknown;
}

export type ParseResult<TOutput> = ParseSuccess<TOutput> | ParseFailure;

export interface SchemaAdapter<TSchema = unknown> {
  readonly name: string;
  parse<TOutput>(schema: TSchema, input: unknown): ParseResult<TOutput>;
  toOpenApiSchema(schema: TSchema): Record<string, unknown>;
}
