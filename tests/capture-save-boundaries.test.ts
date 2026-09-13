import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { saveCapture, undoCapture } from '@/lib/capture/save';
import type { SupabaseBrowser } from '@/lib/supabase/types';

const FAMILY = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const MEMBER = '33333333-3333-4333-8333-333333333333';
const LIST = '44444444-4444-4444-8444-444444444444';
const ITEM = '55555555-5555-4555-8555-555555555555';
const OTHER = '66666666-6666-4666-8666-666666666666';
const BASE = { familyId: FAMILY, userId: USER, memberId: MEMBER, text: 'Pack lunches' };
type Reply = { body?: unknown; status?: number; reject?: boolean; beforeReply?: () => void; hang?: 'honor-abort' | 'ignore-abort' };

/** Installed SDK transport seam: all real builder/filter/response handling executes. */
function fixture(replies: Reply[]) {
  const requests: Array<{ method: string; table: string; query: URLSearchParams; body: unknown; signal?: AbortSignal | null }> = [];
  const pending: Array<() => void> = [];
  const client = createClient('https://capture.invalid', 'synthetic-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      requests.push({ method: init?.method ?? 'GET', table: url.pathname.split('/').pop()!, query: url.searchParams, body: init?.body ? JSON.parse(String(init.body)) : null, signal: init?.signal });
      const reply = replies.shift();
      if (!reply) throw new Error('Unexpected request');
      reply.beforeReply?.();
      // Abort errors do not trigger the SDK's separate automatic GET retry loop.
      if (reply.reject) throw new DOMException('Synthetic lost response', 'AbortError');
      const response = () => new Response(JSON.stringify(reply.body ?? null), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } });
      if (reply.hang) return new Promise<Response>((resolve, reject) => {
        pending.push(() => resolve(response()));
        if (reply.hang === 'honor-abort') init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
      return response();
    } },
  }) as unknown as SupabaseBrowser;
  return { client, requests, release: () => pending.splice(0).forEach(finish => finish()) };
}
const denied = { status: 403, body: { code: '42501', message: 'Synthetic denial', details: null, hint: null } };

describe('capture prerequisites and operation lifetime', () => {
  it.each(['task', 'shopping'] as const)('does not turn a returned failed %s list lookup into creation', async kind => {
    const { client, requests } = fixture([denied]);
    await expect(saveCapture(client, { ...BASE, kind })).rejects.toMatchObject({ outcome: 'failed', stage: 'lookup', dispatched: false });
    expect(requests.map(request => request.method)).toEqual(['GET']);
  });
  it.each(['task', 'shopping'] as const)('does not turn a lost %s list lookup into creation', async kind => {
    const { client, requests } = fixture([{ reject: true }]);
    await expect(saveCapture(client, { ...BASE, kind })).rejects.toMatchObject({ outcome: 'failed', stage: 'lookup' });
    expect(requests).toHaveLength(1);
  });
  it.each(['task', 'shopping'] as const)('allows confirmed empty %s lookup, preserves creator identity and returns checked Undo', async kind => {
    const { client, requests } = fixture([{ body: [] }, { body: [{ id: LIST }], status: 201 }, { body: [{ id: ITEM }], status: 201 }]);
    const result = await saveCapture(client, { ...BASE, kind });
    expect(result).toMatchObject({ count: 1, undo: { ids: [ITEM], familyId: FAMILY } });
    expect(requests.map(request => request.method)).toEqual(['GET', 'POST', 'POST']);
    expect(requests[1].body).toMatchObject({ family_id: FAMILY, created_by: kind === 'task' ? MEMBER : USER });
    expect(requests[2].body).toMatchObject(kind === 'task' ? { list_id: LIST, created_by: MEMBER, assigned_to_id: MEMBER } : [{ list_id: LIST, created_by: USER }]);
  });
  it.each(['task', 'shopping'] as const)('stops after a definitive %s list create failure', async kind => {
    const { client, requests } = fixture([{ body: [] }, denied]);
    await expect(saveCapture(client, { ...BASE, kind })).rejects.toMatchObject({ outcome: 'failed', stage: 'list', dispatched: true });
    expect(requests.map(request => request.method)).toEqual(['GET', 'POST']);
  });
  it.each(['task', 'shopping'] as const)('holds an unconfirmed %s list creation without creating items', async kind => {
    const { client, requests } = fixture([{ body: [] }, { body: [], status: 201 }]);
    await expect(saveCapture(client, { ...BASE, kind })).rejects.toMatchObject({ outcome: 'uncertain', stage: 'list' });
    expect(requests).toHaveLength(2);
  });
  it.each(['task', 'shopping'] as const)('fails closed on malformed required %s list identity', async kind => {
    const { client, requests } = fixture([{ body: [{ id: 'invalid-list-id' }] }]);
    await expect(saveCapture(client, { ...BASE, kind })).rejects.toMatchObject({ outcome: 'failed', stage: 'lookup', dispatched: false });
    expect(requests).toHaveLength(1);
  });
  it.each(['task', 'shopping'] as const)('holds a lost %s list creation response without retrying creation', async kind => {
    const { client, requests } = fixture([{ body: [] }, { reject: true }]);
    await expect(saveCapture(client, { ...BASE, kind })).rejects.toMatchObject({ outcome: 'uncertain', stage: 'list', dispatched: true });
    expect(requests).toHaveLength(2);
  });
  it.each(['note', 'event', 'task', 'shopping'] as const)('makes no %s request for an already retired operation', async kind => {
    const { client, requests } = fixture([]);
    await expect(saveCapture(client, { ...BASE, kind, isCurrent: () => false })).rejects.toMatchObject({ outcome: 'retired', dispatched: false });
    expect(requests).toEqual([]);
  });
  it.each(['task', 'shopping'] as const)('retires %s after list lookup before any write', async kind => {
    let current = true;
    const { client, requests } = fixture([{ body: [{ id: LIST }], beforeReply: () => { current = false; } }]);
    await expect(saveCapture(client, { ...BASE, kind, isCurrent: () => current })).rejects.toMatchObject({ outcome: 'retired', dispatched: false });
    expect(requests.map(request => request.method)).toEqual(['GET']);
  });
  it.each(['task', 'shopping'] as const)('does not create a default %s list after a retired empty lookup', async kind => {
    let current = true;
    const { client, requests } = fixture([{ body: [], beforeReply: () => { current = false; } }]);
    await expect(saveCapture(client, { ...BASE, kind, isCurrent: () => current })).rejects.toMatchObject({ outcome: 'retired', dispatched: false });
    expect(requests.map(request => request.method)).toEqual(['GET']);
  });
  it.each(['task', 'shopping'] as const)('retires %s after creating a list before its item write', async kind => {
    let current = true;
    const { client, requests } = fixture([{ body: [] }, { body: [{ id: LIST }], status: 201, beforeReply: () => { current = false; } }]);
    await expect(saveCapture(client, { ...BASE, kind, isCurrent: () => current })).rejects.toMatchObject({ outcome: 'retired', dispatched: true });
    expect(requests.map(request => request.method)).toEqual(['GET', 'POST']);
  });
  it('does not substitute the auth user for an absent optional task member', async () => {
    const { client, requests } = fixture([{ body: [] }, { body: [{ id: LIST }] }, { body: [{ id: ITEM }] }]);
    await saveCapture(client, { ...BASE, kind: 'task', memberId: null });
    expect(requests[1].body).toMatchObject({ created_by: null });
    expect(requests[2].body).toMatchObject({ created_by: null, assigned_to_id: null });
  });
});

describe('capture request deadlines', () => {
  it.each(['task', 'note'] as const)('bounds an actual SDK %s request and propagates abort with the correct outcome', async kind => {
    vi.useFakeTimers();
    try {
      const { client, requests } = fixture([{ hang: 'honor-abort' }]);
      let observed: unknown = 'pending';
      const operation = saveCapture(client, { ...BASE, kind }).then(value => { observed = value; }, error => { observed = error; });
      await vi.advanceTimersByTimeAsync(0);
      expect(requests).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(observed).toMatchObject({ outcome: kind === 'task' ? 'failed' : 'uncertain', stage: kind === 'task' ? 'lookup' : 'capture', dispatched: kind !== 'task' });
      expect(requests[0].signal?.aborted).toBe(true);
      expect(requests).toHaveLength(1);
      await operation;
    } finally { vi.useRealTimers(); }
  });
  it('keeps a late successful acknowledgement uncertain after expiry without resending', async () => {
    vi.useFakeTimers();
    try {
      const { client, requests, release } = fixture([{ hang: 'ignore-abort', body: [{ id: ITEM }], status: 201 }]);
      let observed: unknown = 'pending';
      const operation = saveCapture(client, { ...BASE, kind: 'note' }).then(value => { observed = value; }, error => { observed = error; });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(observed).toMatchObject({ outcome: 'uncertain', dispatched: true });
      expect(requests[0].signal?.aborted).toBe(true);
      release();
      await vi.advanceTimersByTimeAsync(0);
      await operation;
      expect(observed).toMatchObject({ outcome: 'uncertain' });
      expect(requests).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });
});

describe('capture mutation receipts', () => {
  it.each([null, [], [{}], [{ id: '' }], [{ id: 'not-a-uuid' }], [{ id: ITEM }, { id: OTHER }]].map(body => ({ body })))('never claims a saved note for malformed receipt $body', async ({ body }) => {
    const { client, requests } = fixture([{ body, status: 201 }]);
    await expect(saveCapture(client, { ...BASE, kind: 'note' })).rejects.toMatchObject({ outcome: 'uncertain', stage: 'capture', dispatched: true, href: '/dashboard/notes' });
    expect(requests).toHaveLength(1);
  });
  it.each([[{ id: ITEM }], [{ id: ITEM }, { id: ITEM }]].map(body => ({ body })))('rejects short or duplicate shopping identity receipts $body', async ({ body }) => {
    const { client, requests } = fixture([{ body: [{ id: LIST }] }, { body, status: 201 }]);
    await expect(saveCapture(client, { ...BASE, kind: 'shopping', text: 'milk, eggs' })).rejects.toMatchObject({ outcome: 'uncertain' });
    expect(requests).toHaveLength(2);
  });
  it('returns success only for the complete distinct shopping receipt', async () => {
    const { client } = fixture([{ body: [{ id: LIST }] }, { body: [{ id: ITEM }, { id: OTHER }], status: 201 }]);
    expect(await saveCapture(client, { ...BASE, kind: 'shopping', text: 'milk, eggs' })).toMatchObject({ count: 2, undo: { ids: [ITEM, OTHER], familyId: FAMILY } });
  });
  it.each([{ reject: true }, { status: 502, body: { message: 'Gateway lost upstream response' } }, { status: 406, body: { code: 'PGRST116', message: 'Cannot represent mutation receipt' } }])('never retries an ambiguous dispatched mutation %j', async reply => {
    const { client, requests } = fixture([reply]);
    await expect(saveCapture(client, { ...BASE, kind: 'note' })).rejects.toMatchObject({ outcome: 'uncertain', dispatched: true });
    expect(requests).toHaveLength(1);
  });
  it('distinguishes a definitive rejected mutation', async () => {
    const { client } = fixture([denied]);
    await expect(saveCapture(client, { ...BASE, kind: 'note' })).rejects.toMatchObject({ outcome: 'failed', dispatched: true, code: '42501', message: 'Synthetic denial', cause: denied.body });
  });
  it('distinguishes query construction failure before a mutation dispatch', async () => {
    const cause = new Error('Synthetic construction failure');
    const client = { from() { throw cause; } } as unknown as SupabaseBrowser;
    await expect(saveCapture(client, { ...BASE, kind: 'note' })).rejects.toMatchObject({ outcome: 'failed', dispatched: false, cause });
  });
  it('does not advertise a confirmed write to a retired operation', async () => {
    let current = true;
    const { client, requests } = fixture([{ body: [{ id: ITEM }], status: 201, beforeReply: () => { current = false; } }]);
    await expect(saveCapture(client, { ...BASE, kind: 'note', isCurrent: () => current })).rejects.toMatchObject({ outcome: 'retired', dispatched: true });
    expect(requests).toHaveLength(1);
  });
});

describe('capture Undo boundaries', () => {
  it('fences an old Undo before deletion', async () => {
    const { client, requests } = fixture([]);
    await expect(undoCapture(client, { table: 'notes', ids: [ITEM], familyId: FAMILY }, { isCurrent: () => false })).rejects.toMatchObject({ outcome: 'retired' });
    expect(requests).toEqual([]);
  });
  it.each([[], [{ id: OTHER }], [{ id: ITEM }, { id: ITEM }]].map(body => ({ body })))('does not claim Undone for an incomplete or mismatched receipt $body', async ({ body }) => {
    const { client, requests } = fixture([{ body }]);
    await expect(undoCapture(client, { table: 'notes', ids: [ITEM], familyId: FAMILY })).rejects.toMatchObject({ outcome: 'uncertain', stage: 'undo' });
    expect(requests[0].query.get('family_id')).toBe(`eq.${FAMILY}`);
    expect(requests[0].query.get('select')).toBe('id');
  });
  it('confirms deletion of precisely the captured ids', async () => {
    const { client, requests } = fixture([{ body: [{ id: OTHER }, { id: ITEM }] }]);
    await undoCapture(client, { table: 'notes', ids: [ITEM, OTHER], familyId: FAMILY });
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('DELETE');
  });
  it('does not confirm a partial multi-item deletion', async () => {
    const { client } = fixture([{ body: [{ id: ITEM }] }]);
    await expect(undoCapture(client, { table: 'notes', ids: [ITEM, OTHER], familyId: FAMILY })).rejects.toMatchObject({ outcome: 'uncertain', stage: 'undo' });
  });
  it('does not retry a deletion whose response was lost', async () => {
    const { client, requests } = fixture([{ reject: true }]);
    await expect(undoCapture(client, { table: 'notes', ids: [ITEM], familyId: FAMILY })).rejects.toMatchObject({ outcome: 'uncertain', stage: 'undo', dispatched: true });
    expect(requests).toHaveLength(1);
  });
  it('withholds stale completion after deletion was dispatched', async () => {
    let current = true;
    const { client, requests } = fixture([{ body: [{ id: ITEM }], beforeReply: () => { current = false; } }]);
    await expect(undoCapture(client, { table: 'notes', ids: [ITEM], familyId: FAMILY }, { isCurrent: () => current })).rejects.toMatchObject({ outcome: 'retired', dispatched: true });
    expect(requests).toHaveLength(1);
  });
});
