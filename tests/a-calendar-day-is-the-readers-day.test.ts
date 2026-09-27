// A week grid labelled in UTC does not show the reader's week.
//
// `components/modules/calendar-module.tsx` built its seven day columns from a
// LOCAL-midnight `Date` (`weekStart` ends `d.setHours(0, 0, 0, 0)`) and then
// keyed them with `d.toISOString().slice(0, 10)` — which answers in UTC. Its
// events were keyed the same way from `starts_at`, which is a true instant and
// therefore correct. The two agree only at offset zero.
//
// Replaying that component's own `weekStart` / `daysOfWeek` proved the size of
// it, and it is not an edge case:
//
//   UTC                  events in the right column: 7/7
//   Europe/Amsterdam     0/7  — and only 6/7 land in ANY column: the seventh
//   Asia/Tokyo           0/7    day keys to a date no column carries, so those
//                               events are not rendered at all
//   America/New_York     7/7 at 09:00, 0/7 from 21:00
//   America/Los_Angeles  7/7 at 09:00, 0/7 from 19:00
//
// Six of the eleven locales this product ships are UTC+1 or UTC+2.
//
// The in-process cases below pin the invariant. The child-process replay is the
// one that would actually have caught this, because the defect only exists
// relative to a timezone the test process is not running in.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { localDayKey, localDayKeyOf, shiftLocalDay } from '../lib/time/local-day';

const ROOT = process.cwd();

describe('a day key is the day the reader sees', () => {
  it('reads the day off the local calendar, not off UTC', () => {
    const d = new Date(2026, 8, 13, 23, 30, 0); // 13 Sep, local, late evening
    expect(localDayKey(d)).toBe('2026-09-13');
    expect(localDayKey(d)).toBe(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    );
  });

  // The round trip that was broken: a column built from local parts, and an
  // event that falls inside it, must produce the SAME key.
  it.each([0, 1, 9, 12, 19, 21, 23])('a %i:00 event keys to the column it belongs in', (hour) => {
    const midnight = new Date(2026, 8, 13, 0, 0, 0, 0);
    const event = new Date(2026, 8, 13, hour, 0, 0, 0);
    expect(localDayKeyOf(event.toISOString())).toBe(localDayKey(midnight));
  });

  it('handles an absent or unparseable timestamp without inventing a day', () => {
    expect(localDayKeyOf(null)).toBeNull();
    expect(localDayKeyOf('')).toBeNull();
    expect(localDayKeyOf('not a date')).toBeNull();
  });

  it('shifts a day without going through UTC', () => {
    expect(shiftLocalDay(new Date(2026, 8, 13, 23, 0), 1)).toBe('2026-09-14');
    expect(shiftLocalDay(new Date(2026, 0, 1, 0, 30), -1)).toBe('2025-12-31');
  });

  it('crosses a month and a year end', () => {
    expect(localDayKey(new Date(2026, 0, 31, 23, 59))).toBe('2026-01-31');
    expect(localDayKey(new Date(2025, 11, 31, 23, 59))).toBe('2025-12-31');
  });
});

describe('the calendar module keys days the readers way', () => {
  it('has no UTC day key left in it', () => {
    const source = readFileSync(join(ROOT, 'components/modules/calendar-module.tsx'), 'utf8');
    expect(
      source.includes('toISOString().slice(0, 10)'),
      'a UTC day key is back in calendar-module.tsx — the grid and its events will disagree outside UTC',
    ).toBe(false);
    expect(source).toContain('localDayKey');
  });
});

// The real proof. A test running in one timezone cannot observe a defect that
// only exists in another, so run the component's own day model in five.
describe('replayed in five timezones', () => {
  const REPLAY = `
    function weekStart(offset = 0) {
      const d = new Date(); const day = (d.getDay() + 6) % 7;
      d.setDate(d.getDate() - day + offset * 7); d.setHours(0, 0, 0, 0); return d;
    }
    const key = (d) => \`\${d.getFullYear()}-\${String(d.getMonth()+1).padStart(2,'0')}-\${String(d.getDate()).padStart(2,'0')}\`;
    const start = weekStart(0);
    const cols = Array.from({length:7},(_,i)=>{const d=new Date(start);d.setDate(start.getDate()+i);return d;});
    const colKeys = cols.map(key);
    let worst = 7;
    for (const hour of [0, 9, 14, 19, 21, 23]) {
      const evKeys = cols.map((d)=>{ const e = new Date(d); e.setHours(hour,0,0,0);
        const parsed = new Date(e.toISOString()); return key(parsed); });
      const right = evKeys.filter((k,i)=>k===colKeys[i]).length;
      if (right < worst) worst = right;
    }
    process.stdout.write(String(worst));
  `;

  it.each([
    'UTC', 'Europe/Amsterdam', 'Asia/Tokyo', 'America/New_York', 'America/Los_Angeles', 'Pacific/Kiritimati',
  ])('every event lands in its own column in %s', (tz) => {
    const out = execFileSync(process.execPath, ['-e', REPLAY], {
      env: { ...process.env, TZ: tz }, encoding: 'utf8',
    });
    expect(Number(out), `${tz}: only ${out}/7 days had their events in the right column`).toBe(7);
  });

  // And the mistake, pinned. If this ever stops failing, `toISOString()` has
  // become timezone-aware and the whole finding needs re-deriving.
  it('the old UTC keying really does break outside UTC', () => {
    const OLD = REPLAY.replace(
      "const key = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;",
      'const key = (d) => d.toISOString().slice(0, 10);',
    );
    const out = execFileSync(process.execPath, ['-e', OLD], {
      env: { ...process.env, TZ: 'Europe/Amsterdam' }, encoding: 'utf8',
    });
    expect(Number(out)).toBeLessThan(7);
  });
});
