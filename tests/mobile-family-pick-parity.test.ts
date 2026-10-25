// The phone picks the same active family the server does (N2, N9).
//
// `getBearerUserContext` chooses a user's active family with
// `chooseActiveMembership` (lib/auth/active-membership.ts): the stored
// preference when it names a current family, else the EARLIEST membership,
// ties on the family id — written because row 0 of an unordered query moved
// families after a member rename. The phone's `pickActiveFamily` took row 0 of
// an unordered scan and never selected created_at. For a user in two families
// with no stored preference (or one naming a family they left), the phone sent
// X-Bubaly-Family-Id for its row-0 family while the server resolved another:
// every assistant turn, transcription and calendar read answered 409
// family_changed / context_changed, while Chores and Grocery showed the row-0
// household — and which one that was could flip between launches.
import { describe, expect, it } from 'vitest';
import { chooseActiveMembership } from '@/lib/auth/active-membership';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import type { Db } from '../mobile/src/lib/db';
import { pickActiveFamily, resolveActiveFamily, type MembershipRow } from '../mobile/src/lib/family';
import { parseAssistantResponse } from '../mobile/src/lib/assistant-core';
import { parseTranscribeResponse } from '../mobile/src/lib/voice-core';
import { mobileTranslate } from '../mobile/src/lib/mobile-i18n';

const families = { 'fam-a': { name: 'Second home', timezone: 'UTC' }, 'fam-b': { name: 'First home', timezone: 'Europe/Paris' } };
// Heap order after an UPDATE to the newer row: the family joined LATER comes first.
const rows: MembershipRow[] = [
  { id: 'm-a', family_id: 'fam-a', role: 'adult', display_name: 'Dan', created_at: '2026-02-01T00:00:00Z', families: families['fam-a'] },
  { id: 'm-b', family_id: 'fam-b', role: 'parent', display_name: 'Dan', created_at: '2026-01-01T00:00:00Z', families: families['fam-b'] },
];

describe('pickActiveFamily mirrors chooseActiveMembership', () => {
  it.each([null, undefined, 'fam-left', 'fam-a', 'fam-b'])('agrees with the server for preference %s', (preference) => {
    expect(pickActiveFamily(rows, preference)?.familyId).toBe(chooseActiveMembership(rows, preference)?.family_id);
    expect(pickActiveFamily([...rows].reverse(), preference)?.familyId).toBe(chooseActiveMembership(rows, preference)?.family_id);
  });

  it('takes the earliest membership, not row 0, when nothing is preferred', () => {
    expect(pickActiveFamily(rows, null)?.familyId).toBe('fam-b');
    expect(pickActiveFamily(rows, 'fam-left')?.familyId).toBe('fam-b');
  });

  it('breaks a tie on the family id, and sorts a row without a timestamp last, as the server does', () => {
    const tied = rows.map((r) => ({ ...r, created_at: '2026-01-01T00:00:00Z' }));
    expect(pickActiveFamily(tied, null)?.familyId).toBe(chooseActiveMembership(tied, null)?.family_id);
    expect(pickActiveFamily(tied, null)?.familyId).toBe('fam-a');
    const partial = [{ ...rows[0], created_at: null }, rows[1]];
    expect(pickActiveFamily(partial, null)?.familyId).toBe(chooseActiveMembership(partial, null)?.family_id);
    expect(pickActiveFamily(partial, null)?.familyId).toBe('fam-b');
    const unknown = [{ ...rows[0], created_at: undefined }, { ...rows[1], created_at: 'not a date' }];
    expect(pickActiveFamily(unknown, null)?.familyId).toBe(chooseActiveMembership(unknown, null)?.family_id);
  });
});

describe('resolveActiveFamily reads what the rule needs', () => {
  it('resolves the earliest membership from rows the database returns newest-first', async () => {
    const db = createInMemorySupabase();
    db.seed('families', [{ id: 'fam-a', ...families['fam-a'] }, { id: 'fam-b', ...families['fam-b'] }]);
    db.seed('family_members', [
      { id: 'm-a', family_id: 'fam-a', user_id: 'user-1', role: 'adult', display_name: 'Dan', is_active: true, created_at: '2026-02-01T00:00:00Z' },
      { id: 'm-b', family_id: 'fam-b', user_id: 'user-1', role: 'parent', display_name: 'Dan', is_active: true, created_at: '2026-01-01T00:00:00Z' },
      { id: 'm-x', family_id: 'fam-a', user_id: 'user-2', role: 'child', display_name: 'Kid', is_active: true, created_at: '2025-01-01T00:00:00Z' },
    ]);
    // No preference row at all: the usual way in (invited into both families).
    const resolved = await resolveActiveFamily(db as unknown as Db, 'user-1');
    expect(resolved).toMatchObject({ familyId: 'fam-b', memberId: 'm-b', familyName: 'First home', timezone: 'Europe/Paris' });
    // The server's choice for the same rows, from the same preference.
    const serverRows = db.table('family_members').filter((m) => m.user_id === 'user-1') as { family_id: string; created_at: string }[];
    expect(chooseActiveMembership(serverRows, null)?.family_id).toBe(resolved?.familyId);
    db.seed('user_preferences', [{ user_id: 'user-1', active_family_id: 'fam-a' }]);
    expect((await resolveActiveFamily(db as unknown as Db, 'user-1'))?.familyId).toBe('fam-a');
  });
});

describe('a disagreement the server reports names its remedy, not "try again"', () => {
  it.each(['en-US', 'de-DE', 'fr-FR'])('for the assistant and the microphone in %s', (locale) => {
    const t = (key: string, params?: Record<string, string | number>) => mobileTranslate(locale, key, params);
    const remedy = mobileTranslate(locale, 'mobileAssistant.familyMismatch');
    expect(remedy).not.toBe(mobileTranslate(locale, 'mobileAssistant.contextChanged'));
    expect(parseAssistantResponse(409, { code: 'family_changed', error: 'raw' }, t)).toMatchObject({ ok: false, code: 'family_changed', error: remedy });
    expect(parseTranscribeResponse(409, { code: 'family_changed', error: 'raw' }, t)).toMatchObject({ ok: false, code: 'family_changed', error: remedy });
    // A malformed header is the phone's own bug, not a disagreement: the generic context copy stays.
    expect(parseAssistantResponse(400, { code: 'invalid_family' }, t)).toMatchObject({ ok: false, error: mobileTranslate(locale, 'mobileAssistant.contextChanged') });
  });
});
