import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isInMonth, parseCalendarDate, startOfLocalDay } from '@/lib/utils/calendar-date';

// DATA-021, the general case of DATA-020. A `date` column ('2026-03-01') is a
// day on the family's calendar. The billing page read it with `new Date()`,
// which is UTC midnight, then asked for the local month and day. West of
// Greenwich that is the evening before: a transaction dated March 1 counted
// toward February's spending (and the month-over-month tip compared the wrong
// totals), a bill due March 1 sat on February 28 in the bills calendar, and
// sports results and school grades showed the day before. Node applies a TZ
// change at run time, so this file puts the process in Los Angeles itself.
const zone = process.env.TZ;
beforeAll(() => { process.env.TZ = 'America/Los_Angeles'; });
afterAll(() => { process.env.TZ = zone; });

describe('a date column is read as the day it names', () => {
  it('guards the guard: the process really is west of Greenwich', () => {
    expect(new Date(2026, 0, 1).getTimezoneOffset()).toBe(480);
    expect(new Date('2026-03-01').getMonth(), 'the bug: March 1 reads as February').toBe(1);
  });

  it('a transaction on the 1st is in that month, not the one before', () => {
    expect(isInMonth('2026-03-01', 2026, 2)).toBe(true);
    expect(isInMonth('2026-03-01', 2026, 1)).toBe(false);
    expect(isInMonth('2026-02-28', 2026, 1)).toBe(true);
    expect(isInMonth('2026-01-01', 2026, 0)).toBe(true);
    expect(isInMonth('2026-01-01', 2025, 11)).toBe(false);
    expect(isInMonth(null, 2026, 2)).toBe(false);
    expect(isInMonth('garbage', 2026, 2)).toBe(false);
  });

  it('a bill due on the 1st sits on the 1st', () => {
    const d = parseCalendarDate('2026-03-01')!;
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 2, 1]);
  });

  it('a bill due today is still upcoming at 11 pm', () => {
    const lateToday = new Date(2026, 2, 1, 23, 0);
    expect(parseCalendarDate('2026-03-01')! >= startOfLocalDay(lateToday)).toBe(true);
    expect(parseCalendarDate('2026-02-28')! >= startOfLocalDay(lateToday)).toBe(false);
  });
});

describe('no client page reads a date column as an instant', () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : files(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });

  it('every `date` and `due_date` column in the schema is a date, never a timestamp', () => {
    // The guard below keys on the column name; this is what makes that sound.
    const ddl = readdirSync('supabase/migrations').map((f) => readFileSync(join('supabase/migrations', f), 'utf8')).join('\n');
    expect(ddl).toMatch(/^\s+due_date\s+date\b/im);
    expect(ddl).not.toMatch(/^\s+"?(date|due_date)"?\s+timestamp/im);
  });

  it('uses parseCalendarDate / isInMonth, not new Date(x.date) or new Date(x.due_date)', () => {
    const tree = ['app', 'components'].flatMap(files).filter((f) => /^['"]use client['"]/m.test(readFileSync(f, 'utf8')));
    expect(tree.length).toBeGreaterThan(300);
    const sites = tree.flatMap((f) => readFileSync(f, 'utf8').split('\n')
      .map((line, i) => (/new Date\([\w?.!]+\.(date|due_date)\)/.test(line) ? `${f}:${i + 1}` : null))
      .filter((x): x is string => x !== null));
    expect(sites).toEqual([]);
  });
});
