import { RequestContext } from '@kivin/core';
import { describe, expect, test } from 'bun:test';
import { createLogger, getRequestLogger, LOGGER } from '../src/index';

describe('createLogger', () => {
  test('writes JSON-like structured records with inherited child fields', () => {
    const records: Array<Record<string, unknown>> = [];
    const logger = createLogger({
      serviceName: 'test-service',
      level: 'debug',
      baseFields: { app: 'kivin' },
      now: () => '2026-03-10T00:00:00.000Z',
      sink: (record) => records.push(record),
    });

    logger.child({ component: 'users' }).info('user.created', { id: '1' });

    expect(records).toEqual([{
      level: 'info',
      message: 'user.created',
      timestamp: '2026-03-10T00:00:00.000Z',
      service: 'test-service',
      app: 'kivin',
      component: 'users',
      id: '1',
    }]);
  });

  test('filters out messages below the configured level', () => {
    const records: Array<Record<string, unknown>> = [];
    const logger = createLogger({
      level: 'warn',
      sink: (record) => records.push(record),
    });

    logger.info('ignored');
    logger.error('kept');

    expect(records).toHaveLength(1);
    expect(records[0]?.message).toBe('kept');
  });

  test('does not evaluate lazy fields when the level is disabled', () => {
    const logger = createLogger({
      level: 'error',
      sink: () => {
        throw new Error('sink should not be called');
      },
    });
    let evaluated = false;

    logger.info('ignored', () => {
      evaluated = true;
      return { expensive: true };
    });

    expect(evaluated).toBe(false);
  });

  test('evaluates lazy fields when the level is enabled', () => {
    const records: Array<Record<string, unknown>> = [];
    const logger = createLogger({
      level: 'info',
      sink: (record) => records.push(record),
    });
    let evaluated = false;

    logger.info('kept', () => {
      evaluated = true;
      return { userId: '1' };
    });

    expect(evaluated).toBe(true);
    expect(records).toHaveLength(1);
    expect(records[0]?.userId).toBe('1');
  });

  test('caches the resolved request logger on the context', () => {
    const logger = createLogger();
    let resolveCount = 0;
    const context = new RequestContext(new Request('http://localhost/users'), {}, {
      resolve<T>(token: unknown) {
        if (token !== LOGGER) {
          throw new Error('unexpected token');
        }

        resolveCount += 1;
        return logger as T;
      },
    });

    expect(getRequestLogger(context)).toBe(logger);
    expect(getRequestLogger(context)).toBe(logger);
    expect(resolveCount).toBe(1);
  });
});