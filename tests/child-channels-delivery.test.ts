// "How Bubaly may reach a child directly" was a setting that did nothing.
//
// 0257 documents `family_ai_settings.child_channels` as `{"push": true,
// "email": false}` — how Bubaly may reach a child directly. It was written by
// the settings service, read into `AISettings.childChannels`, and consulted by
// NOTHING: five references in the whole repo, not one of them a decision. A
// family that switched a channel off was told nothing and silenced nothing.
//
// It is enforced at DELIVERY, not in notify(): the setting says how Bubaly may
// REACH a child, not what a child may be told. Turning push off stops the phone
// buzzing; it does not erase the notice from the in-app list the child opens.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { childrenBlockedOn } from '@/lib/notifications/child-channels';

type Member = { user_id: string | null; family_id: string; role: string; is_active: boolean };
type Setting = { family_id: string; child_channels: unknown };

function makeDb(members: Member[], settings: Setting[], fail?: 'members' | 'settings') {
  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    const b: Record<string, unknown> = {};
    Object.assign(b, {
      select: () => b,
      eq: (c: string, v: unknown) => { filters[c] = v; return b; },
      in: (c: string, v: unknown[]) => { filters[c] = v; return b; },
      then: (resolve: (r: { data: unknown; error: unknown }) => void) => {
        if (table === 'family_members') {
          if (fail === 'members') return resolve({ data: null, error: { message: 'boom' } });
          const want = (filters.user_id ?? []) as string[];
          return resolve({
            data: members.filter((m) => m.user_id && want.includes(m.user_id)
              && m.role === filters.role && m.is_active === filters.is_active)
              .map((m) => ({ user_id: m.user_id, family_id: m.family_id })),
            error: null,
          });
        }
        if (fail === 'settings') return resolve({ data: null, error: { message: 'boom' } });
        const want = (filters.family_id ?? []) as string[];
        return resolve({ data: settings.filter((s) => want.includes(s.family_id)), error: null });
      },
    });
    return b;
  };
  return { from } as unknown as SupabaseClient<Database>;
}

const CHILD = { user_id: 'auth-child', family_id: 'fam-1', role: 'child', is_active: true };
const TEEN = { user_id: 'auth-teen', family_id: 'fam-1', role: 'teen', is_active: true };
const PARENT = { user_id: 'auth-parent', family_id: 'fam-1', role: 'parent', is_active: true };
const ALL = [CHILD, TEEN, PARENT].map((m) => m.user_id) as string[];

describe('a family can say how Bubaly may reach its children', () => {
  it('blocks the channel the family switched off, for the child', async () => {
    const db = makeDb([CHILD, TEEN, PARENT], [{ family_id: 'fam-1', child_channels: { push: false } }]);
    expect([...await childrenBlockedOn(db, 'push', ALL)]).toEqual(['auth-child']);
  });

  it('does not touch the other channel', async () => {
    // {"push": false} says nothing about email, and must not be read as "no".
    const db = makeDb([CHILD], [{ family_id: 'fam-1', child_channels: { push: false } }]);
    expect(await childrenBlockedOn(db, 'email', ALL)).toEqual(new Set());
  });

  it('leaves the parent and the teen alone', async () => {
    // 0257 says "reach a CHILD directly". A teen holds their own login and is
    // not what a parent is limiting here; widening this would be a product
    // decision rather than a reading of the contract.
    const db = makeDb([CHILD, TEEN, PARENT], [{ family_id: 'fam-1', child_channels: { push: false, email: false } }]);
    const blocked = await childrenBlockedOn(db, 'push', ALL);
    expect(blocked.has('auth-teen')).toBe(false);
    expect(blocked.has('auth-parent')).toBe(false);
  });

  it('treats absent as allowed, so an untouched setting silences nobody', async () => {
    // The column defaults to `{}` and only an explicit false is a decision —
    // the rule settingsFromRow already applies to `enabled`. Every family that
    // has never opened this setting would otherwise go dark.
    for (const channels of [{}, { push: true }, null, undefined, [], 'nonsense']) {
      const db = makeDb([CHILD], [{ family_id: 'fam-1', child_channels: channels }]);
      expect(await childrenBlockedOn(db, 'push', ALL), JSON.stringify(channels)).toEqual(new Set());
    }
  });

  it('blocks nobody when the family has no settings row at all', async () => {
    const db = makeDb([CHILD], []);
    expect(await childrenBlockedOn(db, 'push', ALL)).toEqual(new Set());
  });

  it('is scoped per family, so one family cannot silence another’s children', async () => {
    const other = { user_id: 'auth-child-b', family_id: 'fam-2', role: 'child', is_active: true };
    const db = makeDb([CHILD, other], [{ family_id: 'fam-1', child_channels: { push: false } }]);
    const blocked = await childrenBlockedOn(db, 'push', [...ALL, 'auth-child-b']);
    expect(blocked.has('auth-child')).toBe(true);
    expect(blocked.has('auth-child-b')).toBe(false);
  });

  it('delivers rather than fails closed when a read breaks', async () => {
    // This governs WHICH CHANNEL a notice takes, not whether a child may be told
    // something. Failing closed would silently drop notifications on a transient
    // database error; quiet hours and the trust gate are the boundaries that
    // fail closed.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const mode of ['members', 'settings'] as const) {
      const db = makeDb([CHILD], [{ family_id: 'fam-1', child_channels: { push: false } }], mode);
      expect(await childrenBlockedOn(db, 'push', ALL), mode).toEqual(new Set());
    }
  });

  it('asks for nothing when there is nobody to ask about', async () => {
    const db = makeDb([CHILD], [{ family_id: 'fam-1', child_channels: { push: false } }]);
    expect(await childrenBlockedOn(db, 'push', [])).toEqual(new Set());
  });
});

describe('both delivery paths consult it', () => {
  it('push filters the whole-family fan-out, not just addressed notices', () => {
    // A whole-family notification has user_id null and fans out to every active
    // member, so filtering only the addressed case would reach a child anyway —
    // by the widest path, and the one a family notices most.
    const src = readFileSync('lib/server/push.ts', 'utf8');
    expect(src).toContain("childrenBlockedOn(supabase, 'push'");
    expect(src).toContain('addressed.filter((id) => !pushBlocked.has(id))');
    // The candidate set is built from BOTH shapes before the filter runs.
    expect(src).toMatch(/if \(n\.user_id\) candidates\.add\(n\.user_id\);\s*\n\s*else for \(const id of await membersOf/);
  });

  it('push still stamps pushed_at when everyone was filtered out', () => {
    // Otherwise the notification is reconsidered on every cron run forever.
    const src = readFileSync('lib/server/push.ts', 'utf8');
    expect(src).toMatch(/pushed_at: new Date\(\)\.toISOString\(\)/);
  });

  it('email folds it into the same skip set as the per-user toggle', () => {
    // Which means a withheld email is resolved into sent_at like any other
    // intentional skip, rather than retried on every run.
    const src = readFileSync('lib/server/notification-emails.ts', 'utf8');
    expect(src).toContain("childrenBlockedOn(supabase, 'email', userIds)");
    expect(src).toContain('for (const id of childEmailOff) emailOff.add(id);');
  });
});
