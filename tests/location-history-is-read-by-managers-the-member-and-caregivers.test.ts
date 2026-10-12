import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { historyInScope, readsEveryonesHistory } from '@/lib/location/history-scope';

// The held 0516, the owner's decision: location history, safety check-ins and
// driving trips are read by a parent or adult, a caregiver and the member a
// row is about. The three screens show each viewer what that rule gives them,
// the same before and after release, and say so to a viewer who reads only
// their own.

const MIGRATION = 'supabase/reserved/0516_location_history_is_read_by_managers_the_member_and_caregivers.sql';
const PROBE = 'docs/audit/reserved/location-history-is-read-by-managers-the-member-and-caregivers-check.sql';
const LOCALES = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'];
const read = (p: string) => readFileSync(p, 'utf8');

describe('who reads location history', () => {
  it('a parent, an adult and a caregiver read everyone\'s; a teen, a child and a guest their own', () => {
    for (const role of ['parent', 'adult', 'caregiver']) expect(readsEveryonesHistory(role), role).toBe(true);
    for (const role of ['teen', 'child', 'guest', null, undefined]) expect(readsEveryonesHistory(role), String(role)).toBe(false);
  });

  it('narrows to the viewer\'s own rows, and a row about nobody is not theirs', () => {
    const rows = [{ id: 'a', member_id: 'me' }, { id: 'b', member_id: 'sib' }, { id: 'c', member_id: null }];
    expect(historyInScope(rows, 'teen', 'me').map((r) => r.id)).toEqual(['a']);
    expect(historyInScope(rows, 'child', null)).toEqual([]);
    expect(historyInScope(rows, 'caregiver', 'carer').map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('the screens show each viewer what the rule gives them', () => {
  it.each([
    ['components/modules/locator-module.tsx', 'const visibleEvents = useMemo(() => historyInScope(events ?? [], role, selfMember?.id), [events, role, selfMember]);', "tr('locator.onlyYourOwnHistory')"],
    ['components/family/check-in-view.tsx', 'const visible = useMemo(() => historyInScope(rows ?? [], role, selfMember?.id), [rows, role, selfMember]);', "t('checkInView.onlyYourOwnCheckIns')"],
    ['components/family/driving-safety-view.tsx', 'const trips = useMemo(() => historyInScope(rows ?? [], role, selfMember?.id), [rows, role, selfMember]);', "tr('drivingSafetyView.onlyYourOwnTrips')"],
  ])('%s', (file, scoped, note) => {
    const src = read(file);
    expect(src).toContain("import { historyInScope, readsEveryonesHistory } from '@/lib/location/history-scope';");
    expect(src).toContain(scoped);
    expect(src).toContain(note);
  });

  it('the locator builds its alerts and history from the scoped rows only', () => {
    const src = read('components/modules/locator-module.tsx');
    expect(src).toContain('arrivalAlerts(visibleEvents, 6)');
    expect(src).not.toContain('arrivalAlerts(events ?? []');
    expect(src).toContain('visibleEvents.map((e) => ({ id: e.id, member_id: e.member_id');
  });

  it('says so in the seven base locales', () => {
    for (const locale of LOCALES) {
      const m = JSON.parse(read(`lib/i18n/messages/${locale}.json`)) as Record<string, string>;
      for (const key of ['locator.onlyYourOwnHistory', 'checkInView.onlyYourOwnCheckIns', 'drivingSafetyView.onlyYourOwnTrips']) {
        expect(m[key], `${locale} ${key}`).toBeTruthy();
      }
    }
  });
});

describe('the database half', () => {
  it('reads the three tables with one predicate, and the probe pins it', () => {
    const sql = read(MIGRATION);
    expect(sql).toContain("foreach t in array array['location_events', 'safety_check_ins', 'driving_trips'] loop");
    expect(sql).toContain("'public.can_manage_family(family_id) or public.is_self_member(member_id) or public.family_role(family_id) = ''caregiver''))'");
    expect(read(PROBE)).toContain("'(is_family_member(family_id) AND (can_manage_family(family_id) OR is_self_member(member_id) OR (family_role(family_id) = ''caregiver''::member_role)))'");
  });
});
