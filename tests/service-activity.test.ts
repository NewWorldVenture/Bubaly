// Behavioural tests for the activity service, which writes to TWO records.
//
// `public.agent_activity` (0127) records what an AGENT did — a person editing
// through the UI produces no row there, an AI or cron actor does. Without that,
// the Command Center feed fills with manual edits and the family can no longer
// see what Bubaly actually handled for them.
//
// `public.audit_logs` (0002) is the household's own record and takes EVERY
// committed change, tagged with who made it. A person's edit writes one row, an
// agent's writes two, and a read writes none.
import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { listFeed, recordActivity, setActivityStatus } from '@/lib/services/activity';
import type { ServiceScope } from '@/lib/services/types';

type Call = { table: string; kind: 'select' | 'insert' | 'update'; filters: Record<string, unknown>; payload?: unknown };
type Reply = { data: unknown; error: unknown };

function makeDb(respond: (call: Call) => Reply) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, kind: 'select', filters: {} };
    calls.push(call);
    const b: Record<string, unknown> = {};
    const chain = () => b;
    const filter = (column: string, value: unknown) => { call.filters[column] = value; return b; };
    Object.assign(b, {
      select: chain, order: chain, limit: chain,
      eq: filter, is: filter, in: filter,
      lt: (c: string, v: unknown) => filter(`lt:${c}`, v),
      insert: (payload: unknown) => { call.kind = 'insert'; call.payload = payload; return b; },
      update: (payload: unknown) => { call.kind = 'update'; call.payload = payload; return b; },
      single: () => Promise.resolve(respond(call)),
      maybeSingle: () => Promise.resolve(respond(call)),
      then: (resolve: (value: Reply) => void) => resolve(respond(call)),
    });
    return b;
  };
  return { db: { from } as unknown as SupabaseClient<Database>, calls };
}

function scopeWith(db: SupabaseClient<Database>, extra?: Partial<ServiceScope>): ServiceScope {
  return {
    db,
    familyId: 'fam-1',
    userId: 'auth-user-1',
    memberId: 'member-1',
    role: 'parent',
    actorKind: 'ai',
    tz: 'America/New_York',
    now: new Date('2026-09-05T12:00:00Z'),
    ...extra,
  };
}

describe('recordActivity', () => {
  it('writes both records when Bubaly acted, trail first', async () => {
    const { db, calls } = makeDb(() => ({ data: { id: 'act-1' }, error: null }));
    const res = await recordActivity(scopeWith(db), {
      agent: 'calendar', action: 'create', resourceId: 'evt-9',
      title: 'Added "Dentist" to the calendar', href: '/dashboard/calendar', memberId: 'member-2',
    });
    expect(res).toEqual({ ok: true, data: { id: 'act-1', recorded: true, trailed: true } });

    // The household trail carries the actor kind, because `actor_id` is the
    // person whose session Bubaly ran in and cannot tell the two apart.
    expect(calls[0].table).toBe('audit_logs');
    expect(calls[0].payload).toMatchObject({
      family_id: 'fam-1', actor_id: 'auth-user-1', action: 'create',
      resource: 'calendar', resource_id: 'evt-9',
      metadata: { actor: 'ai', title: 'Added "Dentist" to the calendar' },
    });

    // agent_activity.created_by references auth.users (0127).
    expect(calls[1].table).toBe('agent_activity');
    expect(calls[1].payload).toMatchObject({
      family_id: 'fam-1', agent: 'calendar', kind: 'action', severity: 'info',
      status: 'active', member_id: 'member-2', created_by: 'auth-user-1',
    });
  });

  it('writes ONLY the household trail for a person acting through the UI', async () => {
    // The §7 symptom: this used to write nothing at all, so an event a parent
    // added by hand left no trace where the identical event Bubaly added did.
    const { db, calls } = makeDb(() => ({ data: { id: 'act-1' }, error: null }));
    const res = await recordActivity(scopeWith(db, { actorKind: 'member' }), {
      agent: 'calendar', action: 'create', title: 'Added an event',
    });
    expect(res).toEqual({ ok: true, data: { id: null, recorded: false, trailed: true } });
    expect(calls.map((c) => c.table)).toEqual(['audit_logs']);
    expect((calls[0].payload as { metadata: unknown }).metadata).toMatchObject({ actor: 'member' });
  });

  it('writes with a null actor for a cron actor, on both records', async () => {
    const { db, calls } = makeDb(() => ({ data: { id: 'act-1' }, error: null }));
    await recordActivity(scopeWith(db, { actorKind: 'system', userId: null }), {
      agent: 'reminders', action: 'send', title: 'Sent the nightly digest',
    });
    expect((calls[0].payload as Record<string, unknown>).actor_id).toBeNull();
    expect((calls[1].payload as Record<string, unknown>).created_by).toBeNull();
  });

  it('records nothing on the trail for something that changed nothing', async () => {
    // A read is not a change. `action: null` is how a call site says so.
    const { db, calls } = makeDb(() => ({ data: { id: 'act-1' }, error: null }));
    const res = await recordActivity(scopeWith(db), { agent: 'documents', action: null, title: 'Opened "Passport"' });
    expect(res).toMatchObject({ ok: true, data: { recorded: true, trailed: false } });
    expect(calls.map((c) => c.table)).toEqual(['agent_activity']);
  });

  it('lets the agent feed still be written when the trail insert fails', async () => {
    // Both entries describe an ALREADY COMMITTED write. Losing one must not
    // cost the other, and must not fail the caller.
    const { db, calls } = makeDb((call) => (call.table === 'audit_logs'
      ? { data: null, error: { message: 'permission denied' } }
      : { data: { id: 'act-1' }, error: null }));
    const res = await recordActivity(scopeWith(db), { agent: 'calendar', action: 'create', title: 'Added an event' });
    expect(res).toMatchObject({ ok: true, data: { id: 'act-1', recorded: true, trailed: false } });
    expect(calls.map((c) => c.table)).toEqual(['audit_logs', 'agent_activity']);
  });

  it('rejects an empty title before writing anything, and surfaces a feed failure', async () => {
    const { db: emptyDb, calls } = makeDb(() => ({ data: null, error: null }));
    expect(await recordActivity(scopeWith(emptyDb), { agent: 'calendar', action: 'create', title: '  ' })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(calls).toHaveLength(0);

    const { db } = makeDb((call) => (call.table === 'audit_logs'
      ? { data: null, error: null }
      : { data: null, error: { message: 'permission denied' } }));
    const res = await recordActivity(scopeWith(db), { agent: 'calendar', action: 'create', title: 'Added an event' });
    expect(res.ok).toBe(false);
  });
});

describe('listFeed', () => {
  it('returns a page and a cursor when more rows exist', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ id: `act-${i}`, created_at: `2026-09-0${i + 1}T00:00:00.000Z` }));
    const { db, calls } = makeDb(() => ({ data: rows, error: null }));
    const res = await listFeed(scopeWith(db), { limit: 2 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.items).toHaveLength(2);
      // The cursor is the last returned row's timestamp, so a new entry
      // arriving mid-scroll cannot shift the page boundary.
      expect(res.data.nextCursor).toBe('2026-09-02T00:00:00.000Z');
    }
    expect(calls[0].filters).toMatchObject({ family_id: 'fam-1', status: 'active' });
  });

  it('has no cursor when the page is the last one', async () => {
    const { db } = makeDb(() => ({ data: [{ id: 'act-1', created_at: '2026-09-01T00:00:00.000Z' }], error: null }));
    const res = await listFeed(scopeWith(db), { limit: 5 });
    expect(res.ok && res.data.nextCursor).toBeNull();
  });

  it('drops the status filter when asked for everything', async () => {
    const { db, calls } = makeDb(() => ({ data: [], error: null }));
    await listFeed(scopeWith(db), { status: 'all', agent: 'calendar', before: '2026-09-02T00:00:00.000Z' });
    expect(calls[0].filters.status).toBeUndefined();
    expect(calls[0].filters).toMatchObject({ agent: 'calendar', 'lt:created_at': '2026-09-02T00:00:00.000Z' });
  });

  it('fails closed on a read error', async () => {
    const { db } = makeDb(() => ({ data: null, error: { message: 'timeout' } }));
    expect((await listFeed(scopeWith(db))).ok).toBe(false);
  });
});

describe('setActivityStatus', () => {
  it('scopes the change to the family and reports a foreign id as not found', async () => {
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    const res = await setActivityStatus(scopeWith(db), 'act-elsewhere', 'dismissed');
    expect(res).toMatchObject({ ok: false, code: 'not_found' });
    expect(calls[0].filters).toMatchObject({ id: 'act-elsewhere', family_id: 'fam-1' });
    expect(calls[0].payload).toEqual({ status: 'dismissed' });
  });
});
