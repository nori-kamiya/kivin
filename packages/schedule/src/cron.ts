// Cron expressions: parsing and "next run" computation in any IANA time zone (DST-aware).
//
// Fields: [second] minute hour day-of-month month day-of-week. Supports `*`, lists (`1,15`), ranges
// (`1-5`), steps (`*/10`, `5-50/5`), month / weekday names (`JAN`, `MON-FRI`), `7` = Sunday and the
// aliases @yearly @annually @monthly @weekly @daily @midnight @hourly. As in Vixie cron, when both
// day-of-month and day-of-week are restricted a day matches if either does.

export interface CronSchedule {
  readonly source: string;
  readonly hasSeconds: boolean;
  /** The first run strictly after `after`, or `undefined` if none within ~8 years. */
  next(after: Date): Date | undefined;
}

const ALIASES: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};
const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: string[];
  namesOffset?: number;
}

const FIELDS: Record<'second' | 'minute' | 'hour' | 'day' | 'month' | 'weekday', FieldSpec> = {
  second: { name: 'second', min: 0, max: 59 },
  minute: { name: 'minute', min: 0, max: 59 },
  hour: { name: 'hour', min: 0, max: 23 },
  day: { name: 'day of month', min: 1, max: 31 },
  month: { name: 'month', min: 1, max: 12, names: MONTH_NAMES, namesOffset: 1 },
  weekday: { name: 'day of week', min: 0, max: 7, names: DAY_NAMES, namesOffset: 0 },
};

function parseValue(text: string, spec: FieldSpec, expression: string) {
  const upper = text.toUpperCase();
  const named = spec.names?.indexOf(upper) ?? -1;
  if (named !== -1) {
    return named + (spec.namesOffset ?? 0);
  }
  if (!/^\d+$/.test(text)) {
    throw new SyntaxError(`Invalid ${spec.name} "${text}" in cron expression "${expression}"`);
  }
  const value = Number(text);
  if (value < spec.min || value > spec.max) {
    throw new SyntaxError(`${spec.name} ${value} out of range ${spec.min}-${spec.max} in cron expression "${expression}"`);
  }
  return value;
}

/** Allowed values of one field, and whether it was `*` (unrestricted). */
function parseField(text: string, spec: FieldSpec, expression: string): { values: Set<number>; any: boolean } {
  const values = new Set<number>();
  let any = false;
  for (const part of text.split(',')) {
    const [rangeText, stepText, extra] = part.split('/');
    if (rangeText === undefined || rangeText === '' || extra !== undefined) {
      throw new SyntaxError(`Invalid ${spec.name} "${part}" in cron expression "${expression}"`);
    }
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) === 0) {
        throw new SyntaxError(`Invalid step "${stepText}" in cron expression "${expression}"`);
      }
      step = Number(stepText);
    }
    let start: number;
    let end: number;
    if (rangeText === '*' || rangeText === '?') {
      start = spec.min;
      end = spec === FIELDS.weekday ? 6 : spec.max;
      if (stepText === undefined && text === rangeText) {
        any = true;
      }
    } else if (rangeText.includes('-')) {
      const [from, to] = rangeText.split('-');
      start = parseValue(from ?? '', spec, expression);
      end = parseValue(to ?? '', spec, expression);
      if (end < start) {
        throw new SyntaxError(`Invalid range "${rangeText}" in cron expression "${expression}"`);
      }
    } else {
      start = parseValue(rangeText, spec, expression);
      end = stepText === undefined ? start : (spec === FIELDS.weekday ? 6 : spec.max);
    }
    for (let value = start; value <= end; value += step) {
      values.add(spec === FIELDS.weekday && value === 7 ? 0 : value);
    }
  }
  return { values, any };
}

// ---- time zones -------------------------------------------------------------------------------

interface WallTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

function wallTimeAt(instant: number, timeZone: string): WallTime {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(instant))) {
    if (part.type !== 'literal') {
      parts[part.type] = Number(part.value);
    }
  }
  return { year: parts.year!, month: parts.month!, day: parts.day!, hour: parts.hour! % 24, minute: parts.minute!, second: parts.second! };
}

const wallToUtcMs = (wall: WallTime) => Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);

/** The instant showing `wall` in `timeZone`, or `undefined` when that wall time is skipped (DST gap). */
function instantOf(wall: WallTime, timeZone: string): number | undefined {
  const target = wallToUtcMs(wall);
  // Two refinements of the zone offset reach the right instant for every real wall time.
  let instant = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const offset = wallToUtcMs(wallTimeAt(instant, timeZone)) - instant;
    const candidate = target - offset;
    if (candidate === instant) {
      break;
    }
    instant = candidate;
  }
  // For an ambiguous wall time (DST fall-back) prefer the earlier instant.
  const earlier = instant - 3_600_000;
  if (wallToUtcMs(wallTimeAt(earlier, timeZone)) === target) {
    return earlier;
  }
  return wallToUtcMs(wallTimeAt(instant, timeZone)) === target ? instant : undefined;
}

/** The process's local time zone. */
export function localTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// ---- schedule ---------------------------------------------------------------------------------

/**
 * Parses a cron expression (5 fields, or 6 with seconds first). `timeZone` is an IANA name such as
 * `Asia/Tokyo` or `UTC`; default: the process's local zone. Throws `SyntaxError` when invalid.
 */
export function parseCron(expression: string, timeZone: string = localTimeZone()): CronSchedule {
  const source = expression.trim();
  const fields = (ALIASES[source.toLowerCase()] ?? source).split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) {
    throw new SyntaxError(`Cron expression "${expression}" must have 5 or 6 fields`);
  }
  // Validate the zone up front (throws RangeError for unknown names).
  formatterFor(timeZone);
  const hasSeconds = fields.length === 6;
  const [secondText, minuteText, hourText, dayText, monthText, weekdayText] = hasSeconds ? fields : ['0', ...fields];
  const seconds = parseField(secondText!, FIELDS.second, expression).values;
  const minutes = parseField(minuteText!, FIELDS.minute, expression).values;
  const hours = parseField(hourText!, FIELDS.hour, expression).values;
  const day = parseField(dayText!, FIELDS.day, expression);
  const months = parseField(monthText!, FIELDS.month, expression).values;
  const weekday = parseField(weekdayText!, FIELDS.weekday, expression);

  const dayMatches = (year: number, month: number, date: number) => {
    const weekdayOfDate = new Date(Date.UTC(year, month - 1, date)).getUTCDay();
    if (day.any && weekday.any) {
      return true;
    }
    if (day.any) {
      return weekday.values.has(weekdayOfDate);
    }
    if (weekday.any) {
      return day.values.has(date);
    }
    return day.values.has(date) || weekday.values.has(weekdayOfDate);
  };
  const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
  const firstAtLeast = (values: Set<number>, from: number, max: number) => {
    for (let value = from; value <= max; value += 1) {
      if (values.has(value)) {
        return value;
      }
    }
    return undefined;
  };

  // Walks wall-clock time field by field (skipping whole months / days / hours that cannot match),
  // then maps the candidate to an instant in the zone.
  const next = (after: Date): Date | undefined => {
    const cursor = wallTimeAt(Math.floor(after.getTime() / 1000) * 1000 + 1000, timeZone);
    const nextDay = () => {
      cursor.day += 1;
      cursor.hour = 0;
      cursor.minute = 0;
      cursor.second = 0;
      if (cursor.day > daysInMonth(cursor.year, cursor.month)) {
        cursor.day = 1;
        cursor.month += 1;
        if (cursor.month > 12) {
          cursor.month = 1;
          cursor.year += 1;
        }
      }
    };
    const nextHour = () => {
      cursor.minute = 0;
      cursor.second = 0;
      cursor.hour += 1;
      if (cursor.hour > 23) {
        nextDay();
      }
    };
    const nextMinute = () => {
      cursor.second = 0;
      cursor.minute += 1;
      if (cursor.minute > 59) {
        nextHour();
      }
    };
    const nextSecond = () => {
      cursor.second += 1;
      if (cursor.second > 59) {
        nextMinute();
      }
    };

    const limitYear = cursor.year + 8;
    while (cursor.year <= limitYear) {
      if (!months.has(cursor.month)) {
        const month = firstAtLeast(months, cursor.month + 1, 12);
        if (month === undefined) {
          cursor.year += 1;
          cursor.month = firstAtLeast(months, 1, 12)!;
        } else {
          cursor.month = month;
        }
        cursor.day = 1;
        cursor.hour = 0;
        cursor.minute = 0;
        cursor.second = 0;
        continue;
      }
      if (!dayMatches(cursor.year, cursor.month, cursor.day)) {
        nextDay();
        continue;
      }
      const hour = firstAtLeast(hours, cursor.hour, 23);
      if (hour === undefined) {
        nextDay();
        continue;
      }
      if (hour !== cursor.hour) {
        cursor.hour = hour;
        cursor.minute = 0;
        cursor.second = 0;
      }
      const minute = firstAtLeast(minutes, cursor.minute, 59);
      if (minute === undefined) {
        nextHour();
        continue;
      }
      if (minute !== cursor.minute) {
        cursor.minute = minute;
        cursor.second = 0;
      }
      const second = firstAtLeast(seconds, cursor.second, 59);
      if (second === undefined) {
        nextMinute();
        continue;
      }
      cursor.second = second;
      const instant = instantOf(cursor, timeZone);
      if (instant === undefined) {
        // The wall time does not exist (DST spring-forward gap): runs inside the gap are skipped.
        nextMinute();
      } else if (instant > after.getTime()) {
        return new Date(instant);
      } else {
        nextSecond();
      }
    }
    return undefined;
  };

  return { source, hasSeconds, next };
}
