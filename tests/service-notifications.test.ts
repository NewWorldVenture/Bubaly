// Behavioural tests for the notifications service — the single entry point
// that replaces fifteen ad-hoc inserts. Covers recipient resolution against
// the real column shape (`notifications.user_id` references auth.users, NULL =
// the whole family), the unread-duplicate guard, quiet-hours deferral through
// the documented `user_preferences.notification_prefs.quietHours` seam, and
// failing closed when the duplicate read cannot answer.
import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { listUnread, markRead, notify } from '@/lib/services/notifications';
import type { ServiceScope } from '@/lib/services/types';

type Call = { table: string; kind: 'select' | 'insert' | 'update' | 'delete'; filters: Record<string, unknown>; payload?: unknown };
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
      select: chain, order: chain, limit: chain, ilike: chain,
      or: (expr: string) => filter('or', expr),
      eq: filter, is: filter, in: filter,
      lt: (c: string, v: unknown) => filter(`lt:${c}`, v),
      lte: (c: string, v: unknown) => filter(`lte:${c}`, v),
      gte: (c: string, v: unknown) => filter(`gte:${c}`, v),
      not: (c: string, op: string, v: unknown) => filter(`not:${c}:${op}`, v),
      insert: (payload: unknown) => { call.kind = 'insert'; call.payload = payload; return b; },
      update: (payload: unknown) => { call.kind = 'update'; call.payload = payload; return b; },
      delete: () => { call.kind = 'delete'; return b; },
      single: () => Promise.resolve(respond(call)),
      maybeSingle: () => Promise.resolve(respond(call)),
      then: (resolve: (value: Reply) => void) => resolve(respond(call)),
    });
    return b;
  };
  return { db: { from } as unknown as SupabaseClient<Database>, calls };
}

const NOW = new Date('2026-09-06T02:00:00Z'); // 22:00 on the 5th in New York

function scopeWith(db: SupabaseClient<Database>, extra?: Partial<ServiceScope>): ServiceScope {
  return {
    db,
    familyId: 'fam-1',
    userId: 'auth-user-1',
    memberId: 'member-1',
    role: 'parent',
    actorKind: 'system',
    tz: 'America/New_York',
    now: NOW,
    ...extra,
  };
}

const MEMBERS = [
  { id: 'member-1', user_id: 'auth-user-1', role: 'parent' },
  { id: 'member-2', user_id: 'auth-user-2', role: 'adult' },
  { id: 'member-3', user_id: 'auth-user-3', role: 'teen' },
  // A managed child profile: no login, so there is no account to notify.
  { id: 'member-4', user_id: null, role: 'child' },
];

/** Default responder: members present, nothing already sent, no preferences on file. */
function defaultRespond(call: Call): Reply {
  if (call.table === 'family_members') return { data: MEMBERS, error: null };
  if (call.table === 'user_preferences') return { data: [], error: null };
  if (call.table === 'notifications' && call.kind === 'select') return { data: [], error: null };
  if (call.table === 'notifications' && call.kind === 'insert') {
    const rows = call.payload as unknown[];
    return { data: rows.map((_, i) => ({ id: `notif-${i + 1}` })), error: null };
  }
  return { data: null, error: null };
}

describe('notify', () => {
  it('sends one family-wide row for the whole family', async () => {
    const { db, calls } = makeDb(defaultRespond);
    const res = await notify(scopeWith(db), { recipients: 'family', type: 'system', title: 'Dinner is at 6' });
    expect(res).toMatchObject({ ok: true, data: { created: 1, duplicates: 0, deferred: 0 } });

    const rows = calls.find((c) => c.table === 'notifications' && c.kind === 'insert')?.payload as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    // notifications.user_id NULL means "the whole family" (0002).
    expect(rows[0]).toMatchObject({ family_id: 'fam-1', user_id: null, type: 'system', title: 'Dinner is at 6' });
    // A family-wide send never needs to look up members.
    expect(calls.some((c) => c.table === 'family_members')).toBe(false);
  });

  it('resolves managers to the parent and adult accounts only', async () => {
    const { db, calls } = makeDb(defaultRespond);
    const res = await notify(scopeWith(db), { recipients: 'managers', type: 'family_invite', title: 'Approve this' });
    expect(res).toMatchObject({ ok: true, data: { created: 2 } });
    const rows = calls.find((c) => c.table === 'notifications' && c.kind === 'insert')?.payload as Record<string, unknown>[];
    expect(rows.map((r) => r.user_id)).toEqual(['auth-user-1', 'auth-user-2']);
    expect(calls.find((c) => c.table === 'family_members')?.filters).toMatchObject({ family_id: 'fam-1', is_active: true });
  });

  it('reports managed profiles instead of silently dropping them', async () => {
    const { db } = makeDb(defaultRespond);
    const res = await notify(scopeWith(db), { recipients: ['member-3', 'member-4'], type: 'chore_due', title: 'Chore due' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.created).toBe(1);
      // "we told everyone" and "we told everyone with an account" differ.
      expect(res.data.skippedMemberIds).toEqual(['member-4']);
    }
  });

  it('does not repeat an identical notification the recipient has not read', async () => {
    const { db, calls } = makeDb((call) => {
      if (call.table === 'notifications' && call.kind === 'select') return { data: [{ user_id: 'auth-user-2' }], error: null };
      return defaultRespond(call);
    });
    const res = await notify(scopeWith(db), {
      recipients: ['member-2', 'member-3'], type: 'document_expiry', title: 'Passport expiring', relatedId: 'doc-1', relatedType: 'document',
    });
    expect(res).toMatchObject({ ok: true, data: { created: 1, duplicates: 1 } });
    const rows = calls.find((c) => c.table === 'notifications' && c.kind === 'insert')?.payload as Record<string, unknown>[];
    expect(rows.map((r) => r.user_id)).toEqual(['auth-user-3']);
    // Dedupe is scoped to the family, the type, the related item and unread only.
    const probe = calls.find((c) => c.table === 'notifications' && c.kind === 'select');
    expect(probe?.filters).toMatchObject({ family_id: 'fam-1', type: 'document_expiry', is_read: false, related_id: 'doc-1' });
  });

  it('falls back to the title as identity when there is no related item', async () => {
    const { db, calls } = makeDb(defaultRespond);
    await notify(scopeWith(db), { recipients: 'family', type: 'system', title: 'Dinner is at 6' });
    const probe = calls.find((c) => c.table === 'notifications' && c.kind === 'select');
    expect(probe?.filters).toMatchObject({ title: 'Dinner is at 6' });
  });

  it('writes nothing when every recipient already has the notice unread', async () => {
    const { db, calls } = makeDb((call) => {
      if (call.table === 'notifications' && call.kind === 'select') return { data: [{ user_id: null }], error: null };
      return defaultRespond(call);
    });
    const res = await notify(scopeWith(db), { recipients: 'family', type: 'system', title: 'Dinner is at 6' });
    expect(res).toMatchObject({ ok: true, data: { created: 0, duplicates: 1 } });
    expect(calls.some((c) => c.table === 'notifications' && c.kind === 'insert')).toBe(false);
  });

  it('fails closed when the duplicate read errors, rather than re-notifying everyone', async () => {
    const { db, calls } = makeDb((call) => {
      if (call.table === 'notifications' && call.kind === 'select') return { data: null, error: { message: 'timeout' } };
      return defaultRespond(call);
    });
    const res = await notify(scopeWith(db), { recipients: 'family', type: 'system', title: 'Dinner is at 6' });
    expect(res.ok).toBe(false);
    expect(calls.some((c) => c.kind === 'insert')).toBe(false);
  });

  it('defers delivery past a recipient’s quiet hours, in the family timezone', async () => {
    const { db, calls } = makeDb((call) => {
      if (call.table === 'user_preferences') {
        return { data: [{ user_id: 'auth-user-2', notification_prefs: { quietHours: { start: 21, end: 7 } } }], error: null };
      }
      return defaultRespond(call);
    });

    // "Now" is 22:00 local — inside a 21:00→07:00 window — so delivery moves to
    // 07:00 local the next morning (11:00Z).
    const res = await notify(scopeWith(db), { recipients: ['member-2', 'member-3'], type: 'chore_due', title: 'Chore due' });
    expect(res).toMatchObject({ ok: true, data: { created: 2, deferred: 1 } });
    const rows = calls.find((c) => c.table === 'notifications' && c.kind === 'insert')?.payload as Record<string, unknown>[];
    expect(rows.find((r) => r.user_id === 'auth-user-2')?.send_at).toBe('2026-09-06T11:00:00.000Z');
    // The member with no preference on file is unaffected.
    expect(rows.find((r) => r.user_id === 'auth-user-3')?.send_at).toBe(NOW.toISOString());
  });

  it('ignores quiet hours for an urgent notification', async () => {
    const { db, calls } = makeDb((call) => {
      if (call.table === 'user_preferences') {
        return { data: [{ user_id: 'auth-user-2', notification_prefs: { quietHours: { start: 21, end: 7 } } }], error: null };
      }
      return defaultRespond(call);
    });
    const res = await notify(scopeWith(db), { recipients: ['member-2'], type: 'medication_due', title: 'Dose now', urgent: true });
    expect(res).toMatchObject({ ok: true, data: { deferred: 0 } });
    const rows = calls.find((c) => c.table === 'notifications' && c.kind === 'insert')?.payload as Record<string, unknown>[];
    expect(rows[0].send_at).toBe(NOW.toISOString());
    // An urgent send never reads preferences at all.
    expect(calls.some((c) => c.table === 'user_preferences')).toBe(false);
  });

  it('ignores a malformed quietHours value instead of throwing', async () => {
    const { db } = makeDb((call) => {
      if (call.table === 'user_preferences') {
        return { data: [{ user_id: 'auth-user-2', notification_prefs: { quietHours: { start: 'late', end: 7 } } }], error: null };
      }
      return defaultRespond(call);
    });
    const res = await notify(scopeWith(db), { recipients: ['member-2'], type: 'chore_due', title: 'Chore due' });
    expect(res).toMatchObject({ ok: true, data: { created: 1, deferred: 0 } });
  });

  it('still delivers when the preference read fails', async () => {
    const { db } = makeDb((call) => {
      if (call.table === 'user_preferences') return { data: null, error: { message: 'permission denied' } };
      return defaultRespond(call);
    });
    // Missing the right delivery window is better than not delivering at all.
    const res = await notify(scopeWith(db), { recipients: ['member-2'], type: 'chore_due', title: 'Chore due' });
    expect(res).toMatchObject({ ok: true, data: { created: 1, deferred: 0 } });
  });

  it('rejects an empty title before touching the database', async () => {
    const { db, calls } = makeDb(defaultRespond);
    const res = await notify(scopeWith(db), { recipients: 'family', type: 'system', title: '   ' });
    expect(res).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(calls).toHaveLength(0);
  });

  it('fails when the member lookup errors rather than notifying nobody quietly', async () => {
    const { db } = makeDb((call) => (call.table === 'family_members'
      ? { data: null, error: { message: 'timeout' } }
      : defaultRespond(call)));
    const res = await notify(scopeWith(db), { recipients: 'managers', type: 'system', title: 'Heads up' });
    expect(res.ok).toBe(false);
  });
});

describe('markRead / listUnread', () => {
  it('scopes the read receipt to the family', async () => {
    const { db, calls } = makeDb(() => ({ data: { id: 'notif-1' }, error: null }));
    const res = await markRead(scopeWith(db), 'notif-1');
    expect(res).toEqual({ ok: true, data: { id: 'notif-1' } });
    expect(calls[0].filters).toMatchObject({ id: 'notif-1', family_id: 'fam-1' });
    expect(calls[0].payload).toEqual({ is_read: true });
  });

  it('withholds notifications whose send_at is still in the future', async () => {
    const { db, calls } = makeDb(() => ({ data: [], error: null }));
    await listUnread(scopeWith(db, { userId: 'auth-user-1' }));
    expect(calls[0].filters).toMatchObject({
      family_id: 'fam-1',
      is_read: false,
      'lte:send_at': NOW.toISOString(),
      or: 'user_id.eq.auth-user-1,user_id.is.null',
    });
  });

  it('reads the whole family queue for a cron scope with no user', async () => {
    const { db, calls } = makeDb(() => ({ data: [], error: null }));
    await listUnread(scopeWith(db, { userId: null }));
    expect(calls[0].filters.or).toBeUndefined();
  });
});
