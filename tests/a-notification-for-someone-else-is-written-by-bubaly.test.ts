// 0388 narrows a member session's INSERT on `notifications` to rows addressed
// to the member themselves: every row becomes a push and an email from
// Bubaly's sender, so a member who could address anyone could also choose the
// text. `notify()` therefore resolves recipients under the caller's own RLS
// (their family only) and writes with the service role for any non-system
// actor. These cases pin both halves: the member scope never writes through
// its own client, the recipient read still does, and a system scope keeps
// the client it was given.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';

type Call = { table: string; kind: 'select' | 'insert'; payload?: unknown };

function makeDb(members: unknown[]) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, kind: 'select' };
    calls.push(call);
    const reply = () => {
      if (table === 'family_members') return { data: members, error: null };
      if (table === 'notifications' && call.kind === 'insert') {
        return { data: (call.payload as unknown[]).map((_, i) => ({ id: `n-${i}` })), error: null };
      }
      return { data: [], error: null };
    };
    const b: Record<string, unknown> = {};
    const chain = () => b;
    Object.assign(b, {
      select: chain, order: chain, limit: chain, eq: chain, is: chain, in: chain, or: chain,
      insert: (payload: unknown) => { call.kind = 'insert'; call.payload = payload; return b; },
      single: () => Promise.resolve(reply()),
      maybeSingle: () => Promise.resolve(reply()),
      then: (resolve: (v: unknown) => void) => resolve(reply()),
    });
    return b;
  };
  return { db: { from } as unknown as SupabaseClient<Database>, calls };
}

const MEMBERS = [
  { id: 'm-parent', user_id: 'u-parent', role: 'parent' },
  { id: 'm-kid', user_id: 'u-kid', role: 'child' },
];

const service = vi.hoisted(() => ({ current: null as null | { db: unknown; calls: Call[] } }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => {
    if (!service.current) throw new Error('service client not prepared');
    return service.current.db;
  },
}));

import { notify } from '@/lib/services/notifications';

function scope(db: SupabaseClient<Database>, actorKind: ServiceScope['actorKind']): ServiceScope {
  return {
    db, familyId: 'fam-1', userId: 'u-kid', memberId: 'm-kid', role: 'child',
    actorKind, tz: 'UTC', now: new Date('2026-09-27T12:00:00Z'),
  };
}

describe('a notification for someone else is written by Bubaly, not by the member', () => {
  beforeEach(() => { service.current = makeDb(MEMBERS); });

  it('writes a member-initiated notification with the service client, never the caller\'s', async () => {
    const own = makeDb(MEMBERS);
    const res = await notify(scope(own.db, 'member'), { type: 'system', title: 'Chore done', recipients: 'managers' });
    expect(res.ok).toBe(true);
    expect(own.calls.filter((c) => c.table === 'notifications' && c.kind === 'insert')).toHaveLength(0);
    const inserts = service.current!.calls.filter((c) => c.table === 'notifications' && c.kind === 'insert');
    expect(inserts).toHaveLength(1);
    expect(inserts[0].payload).toEqual([expect.objectContaining({ family_id: 'fam-1', user_id: 'u-parent' })]);
  });

  it('still resolves recipients under the caller\'s own RLS, so it addresses only their family', async () => {
    const own = makeDb(MEMBERS);
    await notify(scope(own.db, 'member'), { type: 'system', title: 'Hi', recipients: ['m-parent'] });
    expect(own.calls.some((c) => c.table === 'family_members')).toBe(true);
    expect(service.current!.calls.some((c) => c.table === 'family_members')).toBe(false);
  });

  it('treats the AI acting in a member\'s session the same way', async () => {
    const own = makeDb(MEMBERS);
    await notify(scope(own.db, 'ai'), { type: 'system', title: 'Plan ready', recipients: 'managers' });
    expect(own.calls.filter((c) => c.kind === 'insert')).toHaveLength(0);
    expect(service.current!.calls.filter((c) => c.kind === 'insert')).toHaveLength(1);
  });

  it('leaves a system scope on the client it was given', async () => {
    const sys = makeDb(MEMBERS);
    service.current = null; // any createServiceClient() call would throw
    const res = await notify(scope(sys.db, 'system'), { type: 'system', title: 'Tick', recipients: 'managers' });
    expect(res.ok).toBe(true);
    expect(sys.calls.filter((c) => c.table === 'notifications' && c.kind === 'insert')).toHaveLength(1);
  });
});
