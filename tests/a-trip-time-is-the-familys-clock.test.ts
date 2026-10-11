// A `datetime-local` value is a reading on the FAMILY's clock, in both
// directions and on every surface that takes one.
//
// The vacation CRUD forms wrote the raw `YYYY-MM-DDTHH:mm` into `timestamptz`
// columns (resolved as UTC by the database) and sliced the stored UTC string
// back into the input on edit, so a Los Angeles parent's 2:30 PM flight was
// shown as 7:30 AM and the error was locked in on every save. The school,
// sports and homework modules read the same input through `new Date(value)`
// — the DEVICE's zone — so a parent entering a 5pm practice while travelling
// stored a shifted instant. Both now go through the wall-clock helpers.
//
// The vacation screens also never re-read after a write (no `vacation_*`
// table is realtime-published), so a deleted flight stayed on screen and an
// added reservation was missing until the user navigated away.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { datetimeLocalToInstant, instantToDatetimeLocal } from '@/lib/time/datetime-local';
import { at, bodyOf } from './helpers/source-order';

describe('datetime-local ↔ family instant', () => {
  it.each([
    ['America/Los_Angeles', '2026-10-20T14:30', '2026-10-20T21:30:00.000Z'],
    ['Asia/Tokyo', '2026-10-20T14:30', '2026-10-20T05:30:00.000Z'],
    ['Europe/Berlin', '2026-10-20T14:30', '2026-10-20T12:30:00.000Z'],
    ['UTC', '2026-10-20T14:30', '2026-10-20T14:30:00.000Z'],
    // Across the Los Angeles fall-back: 14:30 on 1 November is PST, not PDT.
    ['America/Los_Angeles', '2026-11-01T14:30', '2026-11-01T22:30:00.000Z'],
  ])('%s: %s is the instant %s, and reads back as the same wall time', (tz, local, instant) => {
    expect(datetimeLocalToInstant(local, tz)).toBe(instant);
    expect(instantToDatetimeLocal(instant, tz)).toBe(local);
  });

  it('round-trips a stored timestamptz in PostgREST\'s own text form', () => {
    expect(instantToDatetimeLocal('2026-10-20T21:30:00+00:00', 'America/Los_Angeles')).toBe('2026-10-20T14:30');
  });

  it('refuses what is not a reading rather than guessing', () => {
    expect(datetimeLocalToInstant('', 'UTC')).toBeNull();
    expect(datetimeLocalToInstant('2026-10-20', 'UTC')).toBeNull();
    expect(datetimeLocalToInstant('2026-10-20T25:00', 'UTC')).toBeNull();
    expect(datetimeLocalToInstant('2026-10-20T14:30:00Z', 'UTC')).toBeNull();
    expect(instantToDatetimeLocal(null, 'UTC')).toBe('');
    expect(instantToDatetimeLocal('not a time', 'UTC')).toBe('');
  });
});

describe('the vacation CRUD form converts with the family clock, not the database\'s or the device\'s', () => {
  const shared = readFileSync('components/vacations/shared.tsx', 'utf8');

  it('toRow resolves a datetime field into the instant it names in the family zone', () => {
    const toRow = bodyOf(shared, 'function toRow(', '\n}');
    expect(toRow).toContain("f.type === 'datetime'");
    expect(toRow).toContain('datetimeLocalToInstant(s, timeZone)');
  });

  it('fromRow formats the stored instant back into the same zone, never slicing the UTC string', () => {
    const fromRow = bodyOf(shared, 'function fromRow(', '\n}');
    expect(fromRow).toContain('instantToDatetimeLocal(String(v), timeZone)');
    expect(fromRow).not.toContain('slice(0, 16)');
  });

  it('the section hands both the family clock', () => {
    expect(shared).toContain('const clock = useFamilyClock();');
    expect(shared).toContain('toRow(form, fields, clock.timeZone)');
    expect(shared).toContain('fromRow(row, fields, clock.timeZone)');
  });
});

describe('school, sports and homework save on the family clock', () => {
  it.each([
    ['components/modules/sports-module.tsx', 'async function saveEvent()', 'eventForm.starts_at'],
    ['components/modules/school-module.tsx', 'async function saveEvent()', 'eventForm.starts_at'],
  ])('%s', (file, handler, field) => {
    const src = readFileSync(file, 'utf8');
    const body = bodyOf(src, handler, '\n  }');
    expect(body).toContain(`datetimeLocalToInstant(${field}, clock.timeZone)`);
    expect(body).not.toContain(`new Date(${field}).toISOString()`);
  });

  it('homework reads the due date in and out with the family clock', () => {
    const src = readFileSync('components/modules/homework-module.tsx', 'utf8');
    expect(src).toContain('datetimeLocalToInstant(form.due_at, clock.timeZone)');
    expect(src).toContain('instantToDatetimeLocal(h.due_at, clock.timeZone)');
    expect(src).not.toContain('new Date(form.due_at).toISOString()');
    // The device-field formatter it replaced.
    expect(src).not.toMatch(/getFullYear\(\)\}-\$\{pad\(d\.getMonth/);
  });
});

describe('a vacation write is read back onto the screen', () => {
  it.each([
    ['components/vacations/shared.tsx', 'async function save(', 'success(id ? \'Saved\' : \'Added\');', 'void refresh();'],
    ['components/vacations/shared.tsx', 'async function remove(', "success(t('shared.deleted'));", 'void refresh();'],
    ['components/vacations/trip-itinerary.tsx', 'async function generateDays()', "success(t('trips.addedDays'", 'void daysQuery.refresh();'],
    ['components/vacations/trip-itinerary.tsx', 'async function saveItem(', "success(form.id ? 'Saved' : 'Added');", 'void itemsQuery.refresh();'],
    ['components/vacations/trip-itinerary.tsx', 'async function removeItem(', 'wroteNoRows(removed)', 'void itemsQuery.refresh();'],
    ['components/vacations/trip-overview.tsx', 'async function dismissReco(', 'wroteNoRows(updated)', 'void recosQuery.refresh();'],
    ['components/vacations/trip-budget.tsx', 'async function savePlanned(', "success(t('tripBudget.budgetUpdated'));", 'void refreshBudgets();'],
  ])('%s — %s refreshes after the confirmed write', (file, handler, confirmed, refresh) => {
    const src = readFileSync(file, 'utf8');
    const body = bodyOf(src, handler, '\n  }');
    expect(at(body, confirmed)).toBeLessThan(at(body, refresh));
  });
});
