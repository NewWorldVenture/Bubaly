// A trip's time zone is stored by its exact IANA name, because that is how the
// confirmation-import RPC finds it: `EXISTS (SELECT 1 FROM pg_timezone_names
// WHERE name = v_trip.timezone)`, case-sensitive, names only. The create form,
// the trip editor and `findOrCreateVacation` checked only that Intl could
// format in the zone — and V8/ICU tolerates 'asia/tokyo', 'JST', 'PST' and
// '+09:00' — then stored what was typed. The editor said "Trip time zone
// saved." and every import for the trip was refused.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { findOrCreateVacation } from '@/lib/services/trips';
import type { ServiceScope } from '@/lib/services/types';
import { canonicalDefaultTimezone, canonicalTimezone } from '@/lib/time/zoned';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

function scopeIn(tz: string) {
  const db = createInMemorySupabase({ defaults: { vacations: { status: 'planning', currency: 'USD' } } });
  const scope: ServiceScope = { db: db as unknown as SupabaseClient<Database>, familyId: 'fam-1', userId: 'user-1', memberId: 'mem-1', role: 'parent', actorKind: 'member', tz };
  return { scope, trips: () => db.table('vacations') as Record<string, unknown>[] };
}

describe('canonicalTimezone: the name to store, or a refusal', () => {
  it('corrects the spelling of a zone ICU lists', () => {
    expect(canonicalTimezone('asia/tokyo')).toBe('Asia/Tokyo');
    expect(canonicalTimezone('Asia/tokyo')).toBe('Asia/Tokyo');
    expect(canonicalTimezone(' america/new_york ')).toBe('America/New_York');
    expect(canonicalTimezone('utc')).toBe('UTC');
    expect(canonicalTimezone('Etc/UTC')).toBe('UTC');
  });

  it('refuses abbreviations, offsets and bare links, which Intl tolerates and pg_timezone_names does not hold by that name', () => {
    for (const typed of ['JST', 'PST', 'CST', 'GMT', '+09:00', 'Japan', 'EST5EDT', 'Mars/Olympus', '']) {
      expect(canonicalTimezone(typed), typed).toBeNull();
    }
  });

  it('keeps a correctly written current name ICU knows only by its older alias, rather than rewriting it', () => {
    // ICU resolves these to Asia/Calcutta and Europe/Kiev — backward links a
    // server's tzdata may not carry. What the family typed correctly stays.
    expect(canonicalTimezone('Asia/Kolkata')).toBe('Asia/Kolkata');
    expect(canonicalTimezone('Europe/Kyiv')).toBe('Europe/Kyiv');
    expect(canonicalTimezone('asia/kolkata')).toBeNull();
  });

  it('a family zone nobody typed, as a default, takes the IANA name an alias stands for', () => {
    expect(canonicalDefaultTimezone('America/Los_Angeles')).toBe('America/Los_Angeles');
    expect(canonicalDefaultTimezone('CST')).toBe('America/Chicago');
    expect(canonicalDefaultTimezone('not a zone')).toBeNull();
  });
});

describe('findOrCreateVacation stores the canonical name, or refuses', () => {
  it('stores Asia/Tokyo for "asia/tokyo"', async () => {
    const { scope, trips } = scopeIn('America/Los_Angeles');
    const res = await findOrCreateVacation(scope, { destination: 'Tokyo', startDate: '2026-11-01', timezone: 'asia/tokyo' });
    expect(res).toMatchObject({ ok: true, data: { vacation: { timezone: 'Asia/Tokyo' } } });
    expect(trips()[0].timezone).toBe('Asia/Tokyo');
  });

  it('refuses "JST" and "+09:00" before any write', async () => {
    for (const timezone of ['JST', '+09:00']) {
      const { scope, trips } = scopeIn('America/Los_Angeles');
      expect(await findOrCreateVacation(scope, { destination: 'Tokyo', startDate: '2026-11-01', timezone }), timezone).toMatchObject({ ok: false, code: 'invalid_input' });
      expect(trips()).toHaveLength(0);
    }
  });

  it('a family that keeps a legacy "CST" gets America/Chicago on a trip it did not give a zone', async () => {
    const { scope, trips } = scopeIn('CST');
    expect(await findOrCreateVacation(scope, { destination: 'Austin', startDate: '2026-11-01' })).toMatchObject({ ok: true });
    expect(trips()[0].timezone).toBe('America/Chicago');
  });
});

describe('the create form and the trip editor apply the same rule', () => {
  it('the create form stores the canonical name and refuses what is not one', () => {
    const list = readFileSync('components/vacations/vacations-list.tsx', 'utf8');
    expect(list).toContain('const timezone = typed ? canonicalTimezone(typed) : canonicalDefaultTimezone(clock.timeZone);');
    expect(list).not.toContain('isValidTimezone(');
  });

  it('the trip editor saves the canonical name and refuses what is not one', () => {
    const overview = readFileSync('components/vacations/trip-overview.tsx', 'utf8');
    expect(overview).toContain('const timezone = tzDraft !== null ? canonicalTimezone(tzDraft) : (canonicalTimezone(trip.timezone) ?? canonicalDefaultTimezone(clock.timeZone));');
    expect(overview).toContain("if (!timezone) return toastError(tr('tripOverview.unknownTimeZone'));");
    expect(overview).not.toContain('isValidTimezone(');
  });
});
