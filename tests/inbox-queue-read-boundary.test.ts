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
import { readFileSync } from 'node:fs';
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

/**
 * The two surfaces this queue feeds, read as source. Both failures these pin
 * are invisible to tsc and to any render test that only supplies happy data:
 *
 *  1. THE REASSURING ZERO. `/dashboard/front-desk` passes `voiceResult.data ?? []`
 *     — an empty array — when the `family_inbox_messages` read errors. The stat
 *     tiles used to render `voice.length` unconditionally, so a database that
 *     did not answer showed as "0 Calls / 0 Handled / 0 Urgent": a household
 *     being told nothing had called.
 *  2. THE PERMANENT "HANDLED". `ai_handled` is written the moment `submitRequest`
 *     returns a persisted request. A run that is queued, parked in
 *     awaiting_context, or failed still sets it — so the word the badge uses has
 *     to be the one the flag proves ("Filed with Bubaly"), not the one it does
 *     not ("Handled").
 */
describe('the words and the zeroes on the surfaces this queue feeds', () => {
  const frontDesk = readFileSync('components/modules/front-desk-module.tsx', 'utf8');
  const queue = readFileSync('components/modules/inbox-queue.tsx', 'utf8');

  it('blanks the front desk stat tiles when the read behind them failed', () => {
    const block = frontDesk.slice(frontDesk.indexOf('{STATS.map'), frontDesk.indexOf('</div>', frontDesk.indexOf('{STATS.map')) + 200);
    expect(block).toContain('unavailable?.voice');
    expect(block).toContain('—');
  });

  it('has no fourth tile mixing the frozen call log in with the live voice numbers', () => {
    // `call_logs` is hand-typed history whose own error state lives inside a
    // collapsed section; a tile counting it beside three live numbers reported
    // 0 whenever that query failed, with nothing on screen to say so.
    expect(frontDesk).not.toContain("key: 'legacy'");
    expect(frontDesk).not.toContain('vmCount');
  });

  it('never claims "Handled" on either surface', () => {
    for (const src of [frontDesk, queue]) {
      expect(src).not.toContain("tr('frontDesk.handled')");
      expect(src).not.toContain("t('inboxQueue.handled')");
    }
    expect(frontDesk).toContain("tr('frontDesk.filedWithBubaly')");
    expect(queue).toContain("inboxQueue.filedWithBubaly");
  });

  it('renders the badge off handledBy, so a row a person closed is not credited to Bubaly', () => {
    expect(queue).toContain('HANDLED_LABEL[item.handledBy]');
    expect(queue).toContain("family: 'inboxQueue.done'");
  });
});
