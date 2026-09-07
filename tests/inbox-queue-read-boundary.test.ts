// The household inbox fails closed, per source.
//
// The failure this guards against is the quiet one: `paperwork_items` errors,
// the loader swallows it, and the family sees a queue that says nothing is
// waiting — over a database that never answered. "Nothing arrived" and "we
// could not look" are different facts and this boundary must not merge them.
//
// The fake mirrors the exact call the loader makes:
//   from(table).select(cols).eq('family_id', id)[.neq|.in](…).order(…).limit(n)
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { loadInboxQueue } from '@/lib/inbox/server';

type Reply = { data: unknown; error: unknown };

function chain(result: Reply) {
  const self: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'neq', 'in', 'order']) self[method] = () => self;
  self.limit = () => Promise.resolve(result);
  return self;
}

function fakeSupabase(results: Record<string, Reply>): SupabaseClient<Database> {
  return {
    from: (table: string) => chain(results[table] ?? { data: [], error: null }),
  } as unknown as SupabaseClient<Database>;
}

const OK: Reply = { data: [], error: null };
const NOW = new Date('2026-03-01T12:00:00Z');

const messageRow = {
  id: 'm1', channel: 'email', direction: 'inbound', from_addr: 'school@example.com',
  subject: 'Field trip', body: 'Please reply', ai_summary: null, ai_intent: 'personal',
  ai_handled: false, status: 'new', occurred_at: '2026-03-01T10:00:00Z',
};
const paperworkRow = {
  id: 'p1', kind: 'bill_or_payment', title: 'Water bill', summary: 'Pay by Friday',
  sender: 'City Water', due_on: '2026-03-03', urgency: 'urgent', status: 'needs_action',
  created_at: '2026-02-28T09:00:00Z',
};

describe('loadInboxQueue read boundary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('marks a failing source unavailable and logs it, instead of showing it as empty', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const queue = await loadInboxQueue(fakeSupabase({
      family_inbox_messages: { data: [messageRow], error: null },
      paperwork_items: { data: null, error: { message: 'permission denied for table paperwork_items' } },
      family_communications: OK,
    }), 'fam-1', { now: NOW });

    expect(queue.unavailable).toEqual({ messages: false, paperwork: true, communications: false });
    expect(queue.allFailed).toBe(false);
    // The sources that DID answer are still shown — a partial queue beats none.
    expect(queue.items.map((i) => i.rowId)).toEqual(['m1']);
    expect(err.mock.calls.map((c) => String(c[0]))).toContain('[dashboard/inbox] paperwork read failed');
  });

  it('reports every source down rather than rendering an empty queue', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const readError = { message: 'connection terminated unexpectedly' };
    const queue = await loadInboxQueue(fakeSupabase({
      family_inbox_messages: { data: null, error: readError },
      paperwork_items: { data: null, error: readError },
      family_communications: { data: null, error: readError },
    }), 'fam-1', { now: NOW });

    expect(queue.allFailed).toBe(true);
    expect(queue.items).toEqual([]);
    expect(queue.needsYou).toBe(0);
    // Each namespace logs on its own, so a single broken table is diagnosable.
    const logged = err.mock.calls.map((c) => String(c[0]));
    expect(logged).toContain('[dashboard/inbox] contact-center messages read failed');
    expect(logged).toContain('[dashboard/inbox] paperwork read failed');
    expect(logged).toContain('[dashboard/inbox] communications log read failed');
  });

  it('is silent and merges the rows when every read succeeds', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const queue = await loadInboxQueue(fakeSupabase({
      family_inbox_messages: { data: [messageRow], error: null },
      paperwork_items: { data: [paperworkRow], error: null },
      family_communications: OK,
    }), 'fam-1', { now: NOW });

    expect(err).not.toHaveBeenCalled();
    expect(queue.allFailed).toBe(false);
    expect(queue.unavailable).toEqual({ messages: false, paperwork: false, communications: false });
    // The bill due in two days outranks the unread email.
    expect(queue.items.map((i) => i.rowId)).toEqual(['p1', 'm1']);
    expect(queue.needsYou).toBe(2);
  });

  it('separates an empty answer from a failed one', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const queue = await loadInboxQueue(fakeSupabase({
      family_inbox_messages: OK,
      paperwork_items: OK,
      family_communications: OK,
    }), 'fam-1', { now: NOW });

    expect(queue.items).toEqual([]);
    expect(queue.allFailed).toBe(false);
    expect(queue.unavailable).toEqual({ messages: false, paperwork: false, communications: false });
    expect(err).not.toHaveBeenCalled();
  });
});
