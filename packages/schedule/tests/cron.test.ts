import { parseCron } from '@kivin/schedule';
import { describe, expect, test } from 'bun:test';

const iso = (date: Date | undefined) => date?.toISOString();
const nextN = (expression: string, from: string, count: number, timeZone = 'UTC') => {
  const schedule = parseCron(expression, timeZone);
  const runs: string[] = [];
  let cursor = new Date(from);
  for (let index = 0; index < count; index += 1) {
    const next = schedule.next(cursor)!;
    runs.push(next.toISOString());
    cursor = next;
  }
  return runs;
};

describe('parseCron: fields', () => {
  test('every minute, steps, ranges and lists', () => {
    expect(nextN('* * * * *', '2026-01-01T00:00:30Z', 2)).toEqual(['2026-01-01T00:01:00.000Z', '2026-01-01T00:02:00.000Z']);
    expect(nextN('*/15 * * * *', '2026-01-01T00:07:00Z', 3)).toEqual(['2026-01-01T00:15:00.000Z', '2026-01-01T00:30:00.000Z', '2026-01-01T00:45:00.000Z']);
    expect(nextN('5-50/20 9,17 * * *', '2026-01-01T08:00:00Z', 4)).toEqual(['2026-01-01T09:05:00.000Z', '2026-01-01T09:25:00.000Z', '2026-01-01T09:45:00.000Z', '2026-01-01T17:05:00.000Z']);
  });

  test('seconds field (6 fields)', () => {
    expect(nextN('*/20 * * * * *', '2026-01-01T00:00:05Z', 3)).toEqual(['2026-01-01T00:00:20.000Z', '2026-01-01T00:00:40.000Z', '2026-01-01T00:01:00.000Z']);
    expect(parseCron('0 * * * * *').hasSeconds).toBe(true);
  });

  test('names, weekday 7 = Sunday, weekdays only', () => {
    // 2026-01-02 is a Friday.
    expect(nextN('0 9 * * MON-FRI', '2026-01-02T10:00:00Z', 2)).toEqual(['2026-01-05T09:00:00.000Z', '2026-01-06T09:00:00.000Z']);
    expect(nextN('0 0 * * 7', '2026-01-01T00:00:00Z', 1)).toEqual(['2026-01-04T00:00:00.000Z']);
    expect(nextN('0 0 1 jan,jul *', '2026-02-01T00:00:00Z', 2)).toEqual(['2026-07-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z']);
  });

  test('day-of-month OR day-of-week when both are restricted (Vixie cron)', () => {
    // The 13th, or any Friday.
    expect(nextN('0 0 13 * FRI', '2026-02-01T00:00:00Z', 3)).toEqual(['2026-02-06T00:00:00.000Z', '2026-02-13T00:00:00.000Z', '2026-02-20T00:00:00.000Z']);
  });

  test('aliases and month ends / leap days', () => {
    expect(nextN('@daily', '2026-03-10T12:00:00Z', 1)).toEqual(['2026-03-11T00:00:00.000Z']);
    expect(nextN('@hourly', '2026-03-10T12:30:00Z', 1)).toEqual(['2026-03-10T13:00:00.000Z']);
    expect(nextN('@monthly', '2026-03-10T12:00:00Z', 1)).toEqual(['2026-04-01T00:00:00.000Z']);
    expect(nextN('@weekly', '2026-03-10T12:00:00Z', 1)).toEqual(['2026-03-15T00:00:00.000Z']);
    expect(nextN('@yearly', '2026-03-10T12:00:00Z', 1)).toEqual(['2027-01-01T00:00:00.000Z']);
    expect(nextN('0 0 31 * *', '2026-04-01T00:00:00Z', 2)).toEqual(['2026-05-31T00:00:00.000Z', '2026-07-31T00:00:00.000Z']);
    expect(nextN('0 0 29 2 *', '2026-01-01T00:00:00Z', 1)).toEqual(['2028-02-29T00:00:00.000Z']);
  });

  test('strictly after the given time', () => {
    expect(iso(parseCron('0 12 * * *', 'UTC').next(new Date('2026-01-01T12:00:00Z')))).toBe('2026-01-02T12:00:00.000Z');
    expect(iso(parseCron('0 12 * * *', 'UTC').next(new Date('2026-01-01T11:59:59.900Z')))).toBe('2026-01-01T12:00:00.000Z');
  });

  test('impossible dates have no next run', () => {
    expect(parseCron('0 0 30 2 *', 'UTC').next(new Date('2026-01-01T00:00:00Z'))).toBeUndefined();
  });

  test('invalid expressions throw SyntaxError; unknown zones RangeError', () => {
    for (const bad of ['* * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', '*/0 * * * *', '5-1 * * * *', 'x * * * *', '1,,2 * * * *', '1/2/3 * * * *']) {
      expect(() => parseCron(bad, 'UTC')).toThrow(SyntaxError);
    }
    expect(() => parseCron('* * * * *', 'Mars/Olympus')).toThrow(RangeError);
  });
});

describe('parseCron: time zones', () => {
  test('a fixed-offset zone (Asia/Tokyo, UTC+9)', () => {
    expect(nextN('0 9 * * *', '2026-01-01T00:00:00Z', 2, 'Asia/Tokyo')).toEqual(['2026-01-02T00:00:00.000Z', '2026-01-03T00:00:00.000Z']);
  });

  test('DST: spring-forward gap is skipped, fall-back repeats run once', () => {
    // America/New_York: 2026-03-08 02:00 → 03:00 (no 02:30), 2026-11-01 02:00 → 01:00 (01:30 twice).
    expect(nextN('30 2 * * *', '2026-03-07T12:00:00Z', 2, 'America/New_York')).toEqual(['2026-03-09T06:30:00.000Z', '2026-03-10T06:30:00.000Z']);
    expect(nextN('30 1 * * *', '2026-10-31T12:00:00Z', 2, 'America/New_York')).toEqual(['2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z']);
    // Daily 09:00 local keeps 09:00 across the change (13:00Z before, 14:00Z after).
    expect(nextN('0 9 * * *', '2026-10-31T00:00:00Z', 3, 'America/New_York')).toEqual(['2026-10-31T13:00:00.000Z', '2026-11-01T14:00:00.000Z', '2026-11-02T14:00:00.000Z']);
  });
});
