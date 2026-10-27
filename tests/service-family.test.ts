// Behavioural tests for the family service: the roster with derived age and
// can-manage, the name resolver copied from `lib/assistant/tools.ts` (which is
// retargeted onto this service in a later item), and the preference read that
// degrades honestly for a cron scope with no user.
import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import {
  assertActiveMember,
  getMember,
  getMembers,
  getPreferences,
  matchMemberByName,
  resolveMemberByName,
} from '@/lib/services/family';
import type { ServiceScope } from '@/lib/services/types';

type Call = { table: string; kind: 'select' | 'insert' | 'update' | 'delete'; filters: Record<string, unknown>; payload?: unknown };
type Reply = { data: unknown; error: unknown; count?: number };

function makeDb(respond: (call: Call) => Reply) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, kind: 'select', filters: {} };
    calls.push(call);
    const b: Record<string, unknown> = {};
    let counted = false;
    let ceiling: number | undefined;
    let bounds: { from: number; to: number } | undefined;
    const reply = (): Reply => {
      const result = respond(call);
      if (call.kind !== 'select' || !Array.isArray(result.data)) return result;
      const count = result.data.length;
      const data = bounds ? result.data.slice(bounds.from, bounds.to + 1)
        : ceiling === undefined ? result.data : result.data.slice(0, ceiling);
      return { ...result, data, ...(counted ? { count } : {}) };
    };
    const chain = () => b;
    const filter = (column: string, value: unknown) => { call.filters[column] = value; return b; };
    Object.assign(b, {
      select: (_columns?: string, opts?: { count?: string }) => { counted = opts?.count === 'exact'; return b; },
      limit: (n: number) => { ceiling = n; return b; },
      range: (from: number, to: number) => { bounds = { from, to }; return b; },
      order: chain, ilike: chain, or: chain,
      eq: filter, is: filter, in: filter,
      insert: (payload: unknown) => { call.kind = 'insert'; call.payload = payload; return b; },
      update: (payload: unknown) => { call.kind = 'update'; call.payload = payload; return b; },
      single: () => Promise.resolve(reply()),
      maybeSingle: () => Promise.resolve(reply()),
      then: (resolve: (value: Reply) => void) => resolve(reply()),
    });
    return b;
  };
  return { db: { from } as unknown as SupabaseClient<Database>, calls };
}

const NOW = new Date('2026-09-05T12:00:00Z');

function scopeWith(db: SupabaseClient<Database>, extra?: Partial<ServiceScope>): ServiceScope {
  return {
    db,
    familyId: 'fam-1',
    userId: 'auth-user-1',
    memberId: 'member-1',
    role: 'parent',
    actorKind: 'member',
    tz: 'America/New_York',
    now: NOW,
    ...extra,
  };
}

const ROWS = [
  { id: 'member-1', family_id: 'fam-1', user_id: 'auth-user-1', role: 'parent', display_name: 'Dan', color: '#111', birthday: '1985-01-10', email: null, phone: null, avatar_url: null, is_active: true, onboarding_key: null, created_at: '', updated_at: '' },
  { id: 'member-2', family_id: 'fam-1', user_id: 'auth-user-2', role: 'adult', display_name: 'Sam', color: null, birthday: null, email: null, phone: null, avatar_url: null, is_active: true, onboarding_key: null, created_at: '', updated_at: '' },
  { id: 'member-3', family_id: 'fam-1', user_id: null, role: 'child', display_name: 'Samantha', color: null, birthday: '2018-12-31', email: null, phone: null, avatar_url: null, is_active: true, onboarding_key: null, created_at: '', updated_at: '' },
];

describe('getMembers', () => {
  it('derives age and can-manage, and marks a managed profile as having no login', async () => {
    const { db, calls } = makeDb(() => ({ data: ROWS, error: null }));
    const res = await getMembers(scopeWith(db));
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.data[0]).toMatchObject({ id: 'member-1', age: 41, canManage: true, hasLogin: true });
    expect(res.data[1]).toMatchObject({ id: 'member-2', age: null, canManage: true, hasLogin: true });
    // Birthday later in the year: still 7 on 5 September 2026.
    expect(res.data[2]).toMatchObject({ id: 'member-3', age: 7, canManage: false, hasLogin: false });
    expect(calls[0].filters).toMatchObject({ family_id: 'fam-1', is_active: true });
  });

  it('includes inactive members only when asked', async () => {
    const { db, calls } = makeDb(() => ({ data: ROWS, error: null }));
    await getMembers(scopeWith(db), { includeInactive: true });
    expect(calls[0].filters.is_active).toBeUndefined();
  });

  it('fails closed on a read error', async () => {
    const { db } = makeDb(() => ({ data: null, error: { message: 'timeout' } }));
    const res = await getMembers(scopeWith(db));
    expect(res.ok).toBe(false);
  });
});

describe('matchMemberByName', () => {
  const members = ROWS.map((r) => ({ id: r.id, displayName: r.display_name }));

  it('prefers an exact match over a prefix match', () => {
    // Without exact-first, "Sam" resolves to Samantha in half of all families.
    expect(matchMemberByName(members, 'sam')?.id).toBe('member-2');
    expect(matchMemberByName(members, 'SAMANTHA')?.id).toBe('member-3');
  });

  it('falls back to prefix and then substring', () => {
    expect(matchMemberByName(members, 'saman')?.id).toBe('member-3');
    expect(matchMemberByName(members, 'manth')?.id).toBe('member-3');
  });

  it('returns null for an empty or unmatched name', () => {
    expect(matchMemberByName(members, '  ')).toBeNull();
    expect(matchMemberByName(members, 'Alex')).toBeNull();
  });
});

describe('resolveMemberByName', () => {
  it('returns ok(null) for an unknown name rather than an error', async () => {
    const { db } = makeDb(() => ({ data: ROWS, error: null }));
    // "Add a task for Alex" when there is no Alex is a fact to report, not a failure.
    expect(await resolveMemberByName(scopeWith(db), 'Alex')).toEqual({ ok: true, data: null });
  });

  it('short-circuits on an empty name without a query', async () => {
    const { db, calls } = makeDb(() => ({ data: ROWS, error: null }));
    expect(await resolveMemberByName(scopeWith(db), null)).toEqual({ ok: true, data: null });
    expect(calls).toHaveLength(0);
  });

  it('resolves a name to the member id', async () => {
    const { db } = makeDb(() => ({ data: ROWS, error: null }));
    const res = await resolveMemberByName(scopeWith(db), 'Dan');
    expect(res.ok && res.data?.id).toBe('member-1');
  });
});

describe('getMember / assertActiveMember', () => {
  it('scopes the lookup to the family', async () => {
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    const res = await getMember(scopeWith(db), 'member-elsewhere');
    expect(res).toMatchObject({ ok: false, code: 'not_found' });
    expect(calls[0].filters).toMatchObject({ id: 'member-elsewhere', family_id: 'fam-1' });
  });

  it('denies a continuation for a member who has since been deactivated', async () => {
    const { db } = makeDb(() => ({ data: { ...ROWS[1], is_active: false }, error: null }));
    const res = await assertActiveMember(scopeWith(db), 'member-2');
    expect(res).toMatchObject({ ok: false, code: 'denied' });
    if (!res.ok) expect(res.error).toContain('Sam');
  });
});

describe('getPreferences', () => {
  it('returns column defaults when the user has never opened Settings', async () => {
    const { db } = makeDb((call) => (call.table === 'families'
      ? { data: { id: 'fam-1', name: 'The Hughens', timezone: 'America/New_York' }, error: null }
      : { data: null, error: null }));
    const res = await getPreferences(scopeWith(db));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toMatchObject({ familyName: 'The Hughens', timezone: 'America/New_York' });
      expect(res.data.user).toEqual({ theme: 'dark', pushEnabled: true, emailEnabled: true, notificationPrefs: {} });
    }
  });

  it('reports no user preferences for a cron scope instead of inventing them', async () => {
    const { db, calls } = makeDb(() => ({ data: { id: 'fam-1', name: 'The Hughens', timezone: 'UTC' }, error: null }));
    const res = await getPreferences(scopeWith(db, { userId: null, actorKind: 'system', role: 'system' }));
    expect(res.ok && res.data.user).toBeNull();
    expect(calls.some((c) => c.table === 'user_preferences')).toBe(false);
  });

  it('fails when the family row cannot be read', async () => {
    const { db } = makeDb(() => ({ data: null, error: { message: 'timeout' } }));
    const res = await getPreferences(scopeWith(db));
    expect(res.ok).toBe(false);
  });
});

// Preserve the original roster order above: these adversarial local orders
// distinguish exact/prefix/substring priority instead of agreeing accidentally.
describe('family name resolution with earlier competing matches', () => {
  it('chooses an exact match after an earlier prefix', () => {
    const members = [ROWS[2], ROWS[1]].map((row) => ({ id: row.id, displayName: row.display_name }));
    expect(matchMemberByName(members, 'sam')?.id).toBe('member-2');
    expect(matchMemberByName(members, '  sAM  ')?.id).toBe('member-2');
  });

  it('chooses a prefix after an earlier interior substring', () => {
    const members = [
      { id: 'interior', displayName: 'Old Samantha' },
      { id: 'prefix', displayName: 'Samantha' },
    ];
    expect(matchMemberByName(members, 'saman')?.id).toBe('prefix');
    expect(matchMemberByName(members, 'manth')?.id).toBe('interior');
  });

  it.each([
    ['sam', 'member-2'],
    ['saman', 'member-3'],
  ])('forwards the real roster and %s through matching precedence', async (name, expectedId) => {
    const rows = [{ ...ROWS[2], id: 'interior', display_name: 'Old Samantha' }, ROWS[2], ROWS[1]];
    const { db, calls } = makeDb((call) => ({
      data: rows.filter((row) => Object.entries(call.filters).every(([column, value]) => row[column as keyof typeof row] === value)),
      error: null,
    }));
    const res = await resolveMemberByName(scopeWith(db), name);
    expect(res.ok).toBe(true);
    expect(res.ok && res.data?.id).toBe(expectedId);
    expect(calls).toEqual([{
      table: 'family_members', kind: 'select', filters: { family_id: 'fam-1', is_active: true },
    }]);
  });
});

describe('the family service returns public DTOs from private raw rows', () => {
  type FamilyRow = Database['public']['Tables']['family_members']['Row'];
  const privateRows: FamilyRow[] = [
    { ...ROWS[0], role: 'parent', email: 'synthetic-parent-private@example.invalid', phone: '+15555550121', onboarding_key: 'synthetic-private-parent-invite' },
    { ...ROWS[2], role: 'child', email: 'synthetic-child-private@example.invalid', phone: '+15555550122', onboarding_key: 'synthetic-private-child-invite' },
    { ...ROWS[1], id: 'inactive-adult', role: 'adult', is_active: false, email: 'synthetic-inactive-private@example.invalid', phone: '+15555550123', onboarding_key: 'synthetic-private-inactive-invite' },
    { ...ROWS[0], id: 'foreign-parent', family_id: 'another-family', role: 'parent', email: 'synthetic-foreign-private@example.invalid', phone: '+15555550124', onboarding_key: 'synthetic-private-foreign-invite' },
  ];
  const publicKeys = ['id', 'userId', 'displayName', 'role', 'birthday', 'age', 'isActive', 'canManage', 'hasLogin', 'color', 'avatarUrl'].sort();
  const publicActiveRoster = [
    { id: 'member-1', userId: 'auth-user-1', displayName: 'Dan', role: 'parent', birthday: '1985-01-10', age: 41, isActive: true, canManage: true, hasLogin: true, color: '#111', avatarUrl: null },
    { id: 'member-3', userId: null, displayName: 'Samantha', role: 'child', birthday: '2018-12-31', age: 7, isActive: true, canManage: false, hasLogin: false, color: null, avatarUrl: null },
  ];

  function privateRead(single = false) {
    return makeDb((call) => {
      if (call.table !== 'family_members' || call.kind !== 'select') throw new Error('Only synthetic family-member reads are permitted');
      expect(Object.keys(call.filters).sort()).toEqual(single ? ['family_id', 'id'] : ['family_id', 'is_active']);
      const rows = privateRows.filter((row) => Object.entries(call.filters).every(([column, value]) => {
        if (!['family_id', 'id', 'is_active'].includes(column)) throw new Error('Unexpected synthetic member predicate');
        return row[column as keyof FamilyRow] === value;
      }));
      return { data: single ? rows[0] ?? null : rows, error: null };
    });
  }

  function expectPublicOnly(value: object) {
    expect(Object.keys(value).sort()).toStrictEqual(publicKeys);
    const serialized = JSON.stringify(value);
    for (const row of privateRows) {
      for (const secret of [row.email, row.phone, row.onboarding_key]) {
        expect(secret).not.toBeNull();
        expect(serialized).not.toContain(secret);
      }
    }
  }

  it('omits non-null private contact and onboarding values from the default active roster', async () => {
    const { db, calls } = privateRead();
    const result = await getMembers(scopeWith(db));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toStrictEqual(publicActiveRoster);
    result.data.forEach(expectPublicOnly);
    expect(calls).toEqual([{ table: 'family_members', kind: 'select', filters: { family_id: 'fam-1', is_active: true } }]);
  });

  it('keeps complete-roster reads public while preserving account and managed-child DTO semantics', async () => {
    const { db, calls } = privateRead();
    const result = await getMembers(scopeWith(db), { requireComplete: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toStrictEqual(publicActiveRoster);
    result.data.forEach(expectPublicOnly);
    expect(calls).toEqual([{ table: 'family_members', kind: 'select', filters: { family_id: 'fam-1', is_active: true } }]);
  });

  it('keeps an inactive member detail public and does not return a raw member from another family', async () => {
    const { db, calls } = privateRead(true);
    const result = await getMember(scopeWith(db), 'inactive-adult');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toStrictEqual({ id: 'inactive-adult', userId: 'auth-user-2', displayName: 'Sam', role: 'adult', birthday: null, age: null, isActive: false, canManage: true, hasLogin: true, color: null, avatarUrl: null });
    expectPublicOnly(result.data);
    const foreign = await getMember(scopeWith(db), 'foreign-parent');
    expect(foreign.ok).toBe(false);
    expect(!foreign.ok && foreign.code).toBe('not_found');
    expect(calls).toEqual([
      { table: 'family_members', kind: 'select', filters: { id: 'inactive-adult', family_id: 'fam-1' } },
      { table: 'family_members', kind: 'select', filters: { id: 'foreign-parent', family_id: 'fam-1' } },
    ]);
  });
});
