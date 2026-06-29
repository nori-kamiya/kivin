import { defineModule, readPathname, type ModuleDefinition, type NestLikeMiddleware, type RequestContext } from '@kivin/core';
import { Injectable } from '@kivin/decorators';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  [key: string]: unknown;
}

export type LogFieldsInput = LogFields | (() => LogFields);

export interface LogRecord extends LogFields {
  level: LogLevel;
  message: string;
  timestamp: string;
  service: string;
}

export interface Logger {
  child(fields: LogFields): Logger;
  isLevelEnabled(level: LogLevel): boolean;
  debug(message: string, fields?: LogFieldsInput): void;
  info(message: string, fields?: LogFieldsInput): void;
  warn(message: string, fields?: LogFieldsInput): void;
  error(message: string, fields?: LogFieldsInput): void;
}

export interface LoggerModuleOptions {
  serviceName?: string;
  level?: LogLevel;
  baseFields?: LogFields;
  sink?: (record: LogRecord) => void;
  now?: () => string;
}

interface NormalizedLoggerOptions {
  serviceName: string;
  level: LogLevel;
  levelValue: number;
  baseFields: LogFields;
  sink: (record: LogRecord) => void;
  now: () => string;
}

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const REQUEST_LOGGER_KEY = 'kivin.logger.request';

export const LOGGER = Symbol.for('@kivin.logger');
export const LOGGER_OPTIONS = Symbol.for('@kivin.logger.options');

export function createLoggerModule(options: LoggerModuleOptions = {}): ModuleDefinition {
  return defineModule({
    providers: [
      {
        provide: LOGGER_OPTIONS,
        useValue: normalizeLoggerOptions(options),
      },
      {
        provide: LOGGER,
        useFactory: (container) => createLogger(container.resolve(LOGGER_OPTIONS)),
      },
      RequestLoggerMiddleware,
    ],
    controllers: [],
    imports: [],
  });
}

export function createLogger(options: LoggerModuleOptions = {}): Logger {
  return new JsonLogger(normalizeLoggerOptions(options), {});
}

export function getRequestLogger(context: RequestContext): Logger {
  const cachedLogger = context.get<Logger>(REQUEST_LOGGER_KEY);
  if (cachedLogger) {
    return cachedLogger;
  }

  const logger = context.inject<Logger>(LOGGER);
  context.set(REQUEST_LOGGER_KEY, logger);
  return logger;
}

@Injectable({ deps: [LOGGER] })
export class RequestLoggerMiddleware implements NestLikeMiddleware {
  constructor(private readonly rootLogger: Logger) {}

  async handle(context: RequestContext, next: () => Promise<Response>) {
    const infoEnabled = this.rootLogger.isLevelEnabled('info');
    const errorEnabled = this.rootLogger.isLevelEnabled('error');
    const startedAt = performance.now();
    const request = context.request;
    const requestId = request.headers.get('x-request-id') ?? context.get<string>('requestId') ?? crypto.randomUUID();
    context.set(REQUEST_LOGGER_KEY, this.rootLogger);
    let requestLogger: Logger | undefined;
    const getRequestLogger = () => {
      requestLogger ??= this.rootLogger.child({
        requestId,
        method: request.method,
        path: readPathname(request.url),
      });
      context.set(REQUEST_LOGGER_KEY, requestLogger);
      return requestLogger;
    };

    if (infoEnabled) {
      getRequestLogger().info('request.start');
    }

    try {
      const response = await next();
      if (infoEnabled) {
        getRequestLogger().info('request.finish', {
          status: response.status,
          durationMs: elapsed(startedAt),
        });
      }
      return response;
    } catch (error) {
      if (errorEnabled) {
        getRequestLogger().error('request.error', {
          durationMs: elapsed(startedAt),
          error: serializeError(error),
        });
      }
      throw error;
    }
  }
}

class JsonLogger implements Logger {
  private readonly levelValue: number;

  constructor(
    private readonly options: NormalizedLoggerOptions,
    private readonly fields: LogFields,
  ) {
    this.levelValue = options.levelValue;
  }

  child(fields: LogFields): Logger {
    return new JsonLogger(this.options, {
      ...this.fields,
      ...fields,
    });
  }

  isLevelEnabled(level: LogLevel) {
    return LOG_LEVEL_ORDER[level] >= this.levelValue;
  }

  debug(message: string, fields?: LogFieldsInput) {
    this.log('debug', message, fields);
  }

  info(message: string, fields?: LogFieldsInput) {
    this.log('info', message, fields);
  }

  warn(message: string, fields?: LogFieldsInput) {
    this.log('warn', message, fields);
  }

  error(message: string, fields?: LogFieldsInput) {
    this.log('error', message, fields);
  }

  private log(level: LogLevel, message: string, fields?: LogFieldsInput) {
    if (!this.isLevelEnabled(level)) {
      return;
    }

    const resolvedFields = typeof fields === 'function' ? fields() : fields;

    this.options.sink({
      level,
      message,
      timestamp: this.options.now(),
      service: this.options.serviceName,
      ...this.options.baseFields,
      ...this.fields,
      ...(resolvedFields ?? {}),
    });
  }
}

function normalizeLoggerOptions(options: LoggerModuleOptions): NormalizedLoggerOptions {
  const level = options.level ?? 'info';
  return {
    serviceName: options.serviceName ?? 'kivin-app',
    level,
    levelValue: LOG_LEVEL_ORDER[level],
    baseFields: options.baseFields ?? {},
    sink: options.sink ?? defaultSink,
    now: options.now ?? (() => new Date().toISOString()),
  };
}

function defaultSink(record: LogRecord) {
  console.log(JSON.stringify(record));
}

function elapsed(startedAt: number) {
  return Number((performance.now() - startedAt).toFixed(3));
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  return String(error);
}