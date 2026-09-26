import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ageOn, nextBirthday, parseBirthday } from '@/lib/utils/birthday';
import { ageFromBirthday } from '@/lib/home/home-data';

// A birthday is stored as a date ('2015-03-04'). Four places read it with
// `new Date(birthday)`, which is UTC midnight, and then asked for the local
// month and day. West of Greenwich that is the evening before, so on every US
// device the family page said "Today" for a birthday that was tomorrow, an age
// turned over a day early, and the printed check-in sheet gave a date of birth
// one day off. Node applies a TZ change at run time, so these cases put the
// process in Los Angeles themselves and fail on a UTC host too.
const zone = process.env.TZ;
beforeAll(() => { process.env.TZ = 'America/Los_Angeles'; });
afterAll(() => { process.env.TZ = zone; });

describe('a birthday is read as the day it names', () => {
  it('guards the guard: the process really is west of Greenwich', () => {
    expect(new Date(2026, 0, 1).getTimezoneOffset()).toBe(480);
    expect(new Date('2015-03-04').getDate(), 'the bug this file is about').toBe(3);
  });

  it('parses to local midnight on that day', () => {
    const b = parseBirthday('2015-03-04')!;
    expect([b.getFullYear(), b.getMonth(), b.getDate(), b.getHours()]).toEqual([2015, 2, 4, 0]);
    expect(parseBirthday('not a date')).toBeNull();
    expect(parseBirthday(null)).toBeNull();
  });

  it('an age turns over on the birthday, not the evening before', () => {
    expect(ageOn('2015-03-04', new Date(2026, 2, 3, 20, 0))).toBe(10);
    expect(ageOn('2015-03-04', new Date(2026, 2, 4, 0, 1))).toBe(11);
    expect(ageFromBirthday('2015-03-04', new Date(2026, 2, 3, 20, 0))).toBe(10);
  });

  it('"Today" is the birthday itself', () => {
    expect(nextBirthday('2015-03-04', new Date(2026, 2, 3, 20, 0))).toMatchObject({ inDays: 1, turning: 11 });
    expect(nextBirthday('2015-03-04', new Date(2026, 2, 4, 9, 0))).toMatchObject({ inDays: 0, turning: 11 });
    expect(nextBirthday('2015-03-04', new Date(2026, 2, 5, 9, 0))).toMatchObject({ inDays: 364, turning: 12 });
  });
});

describe('nothing reads a birthday as an instant', () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : files(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
  // lib/network/contribution.ts reads UTC on both sides (getUTC* against
  // getUTC*), so its day is consistent; it bands ages for aggregates only.
  const EXEMPT = new Set(['lib/network/contribution.ts']);

  it('uses parseBirthday / ageOn / nextBirthday, not new Date(birthday)', () => {
    const tree = ['app', 'components', 'lib'].flatMap(files);
    expect(tree.length).toBeGreaterThan(500);
    const sites = tree.filter((f) => !EXEMPT.has(f))
      .filter((f) => /new Date\((\w+\.)?(birthday|birth_date|dob|date_of_birth)\)/.test(readFileSync(f, 'utf8')));
    expect(sites).toEqual([]);
  });
});
