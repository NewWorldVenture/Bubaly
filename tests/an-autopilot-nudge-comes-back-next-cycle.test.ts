import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appointmentSuggestions, birthdaySuggestions, momentPrepSuggestions, renewalSuggestions, type FamilySnapshot,
} from '@/lib/autopilot/engine';

/**
 * AN AUTOPILOT NUDGE CAME ONCE, EVER.
 *
 * The scan (lib/autopilot/scan.ts) keeps whatever row already exists under a
 * draft's `dedupeKey` — open, done or dismissed — and skips the draft:
 * "respect prior state". So a key has to name the OCCURRENCE a nudge is
 * about, or the first occurrence's row blocks every later one. The insurance
 * and refill nudges already date their keys. Four did not:
 *
 *   renewal:<id>          — "Mark renewed" rolls the expiry a year on and
 *                           keeps the row; next year's nudge was blocked.
 *   birthday:<member>     — a birthday comes back every year.
 *   appt:<id>             — a weekly series is one id every week.
 *   moment-*:<id>         — the same.
 *
 * Each key now carries the day it is about, in the family's day.
 */

const ROOT = join(__dirname, '..');
const snapshot = (over: Partial<FamilySnapshot>): FamilySnapshot =>
  ({ today: '2026-06-24', tz: 'UTC', renewals: [], appointments: [], birthdays: [], events: [], ...over } as unknown as FamilySnapshot);
const keys = (drafts: { dedupeKey: string }[]) => drafts.map((d) => d.dedupeKey);

describe('a renewal is nudged every year', () => {
  const passport = (expiresOn: string) => ({ id: 'r1', label: 'Passport', expiresOn });
  it('this year and next year are different keys; two scans in one window are the same', () => {
    expect(keys(renewalSuggestions(snapshot({ renewals: [passport('2026-06-29')] })))).toEqual(['renewal:r1:2026-06-29']);
    expect(keys(renewalSuggestions(snapshot({ today: '2026-06-27', renewals: [passport('2026-06-29')] })))).toEqual(['renewal:r1:2026-06-29']);
    // "Mark renewed": the same row, a year on.
    expect(keys(renewalSuggestions(snapshot({ today: '2027-06-24', renewals: [passport('2027-06-29')] })))).toEqual(['renewal:r1:2027-06-29']);
  });
});

describe('a birthday is nudged every year', () => {
  const mia = { memberId: 'm1', name: 'Mia', birthday: '2015-06-26' };
  it('names the birthday it is about', () => {
    expect(keys(birthdaySuggestions(snapshot({ birthdays: [mia] })))).toEqual(['birthday:m1:2026-06-26']);
    expect(keys(birthdaySuggestions(snapshot({ today: '2026-06-26', birthdays: [mia] }))), 'on the day').toEqual(['birthday:m1:2026-06-26']);
    expect(keys(birthdaySuggestions(snapshot({ today: '2027-06-20', birthdays: [mia] })))).toEqual(['birthday:m1:2027-06-26']);
  });
});

describe('a weekly appointment is nudged every week', () => {
  const practice = (startsAt: string) => ({ id: 'a1', title: 'Practice', startsAt, memberId: null, hasReminder: false });
  it('each occurrence has its own key, by the family\'s day', () => {
    expect(keys(appointmentSuggestions(snapshot({ appointments: [practice('2026-06-24T15:00:00.000Z')] })))).toEqual(['appt:a1:2026-06-24']);
    expect(keys(appointmentSuggestions(snapshot({ today: '2026-07-01', appointments: [practice('2026-07-01T15:00:00.000Z')] })))).toEqual(['appt:a1:2026-07-01']);
    // 02:00Z on the 25th is still the 24th in Los Angeles.
    expect(keys(appointmentSuggestions(snapshot({ tz: 'America/Los_Angeles', appointments: [practice('2026-06-25T02:00:00.000Z')] })))).toEqual(['appt:a1:2026-06-24']);
  });
});

describe('a recurring event\'s prep is nudged every occurrence', () => {
  const game = (startsAt: string) => ({ id: 'e1', title: 'Soccer game vs Hawks', startsAt, endsAt: null, memberId: 'm1', allDay: false, location: 'Field 3' });
  it('leave-by and shopping keys carry the occurrence\'s day', () => {
    const week1 = keys(momentPrepSuggestions(snapshot({ events: [game('2026-06-25T15:00:00.000Z')] })));
    const week2 = keys(momentPrepSuggestions(snapshot({ today: '2026-07-01', events: [game('2026-07-02T15:00:00.000Z')] })));
    expect(week1.length).toBeGreaterThan(0);
    expect(week1.every((k) => k.endsWith(':e1:2026-06-25'))).toBe(true);
    expect(week2.every((k) => k.endsWith(':e1:2026-07-02'))).toBe(true);
    expect(week1.some((k) => week2.includes(k))).toBe(false);
  });
});

describe('the contract these keys answer to', () => {
  it('the scan keeps a prior row under the key and skips the draft', () => {
    expect(readFileSync(join(ROOT, 'lib/autopilot/scan.ts'), 'utf8')).toContain('if (prior) continue; // respect prior state');
  });
  it('no nudge about a recurring fact is keyed by its row alone', () => {
    const engine = readFileSync(join(ROOT, 'lib/autopilot/engine.ts'), 'utf8');
    // `renewal:${r.id}`, with nothing after the id, is the shape that blocked.
    expect(engine.match(/dedupeKey: `(?:renewal|appt|birthday|moment-leaveby|moment-shop):\$\{[^}]+\}`/g) ?? []).toEqual([]);
  });
});
