// lib/admin/digest-delivery.ts: the per-recipient replay engine for the admin
// digest, driven through its public API with an in-memory store and a fake
// provider that follows Resend's documented idempotency semantics. Synthetic
// data only; no database, no network, no email.
//
// What these tests prove: the engine's rules and its use of the storage and
// provider contracts, under the interleavings, crashes and failures below.
// What they do NOT prove: anything about PostgreSQL. The in-memory store is
// atomic because each step is one synchronous critical section; a database
// adapter must earn the same properties (docs/admin-digest-delivery-contract.md)
// and pass tests/helpers/digest-delivery-store-contract.ts against a real
// database.
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RESEND_KEY_RETENTION_MS, classifyResendResponse, deliverDigestOccurrence, freezePlan, idempotencyKeyFor,
  payloadJsonOf, recipientKeyOf, resumeDigestOccurrence,
  type EngineConfig, type EngineDeps, type OccurrencePlan,
} from '@/lib/admin/digest-delivery';
import {
  FakeClock, FakeResendProvider, HOUR, MINUTE, MemoryDigestDeliveryStore, deferred, never, type StoreHook,
} from './helpers/digest-delivery-fakes';
import { contractPlan, describeDigestDeliveryStoreContract } from './helpers/digest-delivery-store-contract';

describeDigestDeliveryStoreContract('in-memory store', (clock) => new MemoryDigestDeliveryStore(clock.now));

const ONE = 'admin-one@example.test';
const TWO = 'admin-two@example.test';
const K1 = recipientKeyOf(ONE);
const K2 = recipientKeyOf(TWO);
const T0 = '2026-09-30T12:31:00.000Z';
const OCC = 'admin-digest:2026-09-30T12:30:00.000Z';
/** The engine visits recipients in key order; some crash tests need to know which comes second. */
const [FIRST, SECOND] = [{ to: ONE, key: K1 }, { to: TWO, key: K2 }].sort((a, b) => (a.key < b.key ? -1 : 1));

const CONFIG: EngineConfig = {
  leaseMs: 5 * MINUTE, // on the store's (fake) clock
  sendTimeoutMs: 150, // real milliseconds: only the timeout tests wait for it
  maxAttempts: 5,
  providerKeyRetentionMs: RESEND_KEY_RETENTION_MS,
  retentionSafetyMarginMs: HOUR,
};

/** Resend's own rule for a key, as #692's sendEmail enforces it. */
const KEY_RULE = /^[\x21-\x7e](?:[\x20-\x7e]{0,254}[\x21-\x7e])?$/;

function world(start = T0) {
  const clock = new FakeClock(start);
  const store = new MemoryDigestDeliveryStore(clock.now);
  const provider = new FakeResendProvider(clock.now);
  const engine = (owner: string, over: Partial<EngineDeps> = {}): EngineDeps => ({
    store, provider, owner, config: CONFIG, now: clock.now, ...over,
  });
  return { clock, store, provider, engine };
}

const plan = (over: Partial<OccurrencePlan> = {}) => contractPlan(over);
const hookOn = (method: string, phase: 'before' | 'after', key: string | null, act: () => void | Promise<void>): StoreHook =>
  (m, p, k) => (m === method && p === phase && (key === null || k === key) ? act() : undefined);
const fail = () => { throw new Error('synthetic storage failure'); };

afterEach(() => { vi.useRealTimers(); });

// ── Inputs ─────────────────────────────────────────────────────────────────

describe('inputs are checked before anything is stored or sent', () => {
  const cases: [string, Partial<OccurrencePlan>][] = [
    ['an empty recipient list (the caller must refuse it, as #685 does)', { recipients: [] }],
    ['a duplicate recipient, however it is cased', { recipients: [ONE, ' Admin-One@Example.test '] }],
    ['a recipient that is not one plain address', { recipients: ['Admin <admin-one@example.test>'] }],
    ['a payload field beyond { from, subject, html }', { payload: { ...plan().payload, headers: { Authorization: 'x' } } as never }],
    ['a subject with a line break', { payload: { ...plan().payload, subject: 'a\r\nBcc: x@example.test' } }],
    ['an empty body', { payload: { ...plan().payload, html: '   ' } }],
    ['a window that ends before it starts', { window: { start: '2026-09-30T12:30:00Z', end: '2026-09-29T12:30:00Z' } }],
    ['an occurrence id with a line break', { occurrenceId: 'admin-digest:\n1' }],
  ];
  it.each(cases)('%s', async (_name, over) => {
    const { store, provider, engine } = world();
    await expect(deliverDigestOccurrence(plan(over), engine('a'))).rejects.toThrow(TypeError);
    expect(store.calls).toEqual([]);
    expect(provider.requests).toEqual([]);
  });

  it.each<[string, Partial<EngineConfig>]>([
    ['a lease no longer than the send deadline', { leaseMs: 150 }],
    ['a retention margin no longer than the send deadline', { retentionSafetyMarginMs: 150 }],
    ['a margin as long as the retention window', { retentionSafetyMarginMs: RESEND_KEY_RETENTION_MS }],
    ['zero attempts', { maxAttempts: 0 }],
    ['a retention longer than the provider\'s verified 24 h', { providerKeyRetentionMs: 48 * HOUR }],
  ])('a config with %s is refused', async (_name, over) => {
    const { store, provider, engine } = world();
    await expect(deliverDigestOccurrence(plan(), engine('a', { config: { ...CONFIG, ...over } }))).rejects.toThrow(TypeError);
    expect(store.calls).toEqual([]);
    expect(provider.requests).toEqual([]);
  });
});

describe('keys and bytes', () => {
  it('each recipient has one stable key: a function of occurrence and recipient only, free of the address, within Resend\'s rule', () => {
    const a = freezePlan(plan(), new Date(T0));
    const b = freezePlan(plan({ payload: { ...plan().payload, html: '<p>other</p>' }, recipients: [TWO.toUpperCase(), ONE] }), new Date('2027-01-01T00:00:00Z'));
    expect(a.deliveries.map((d) => d.idempotencyKey)).toEqual(b.deliveries.map((d) => d.idempotencyKey));
    for (const d of a.deliveries) {
      expect(d.idempotencyKey).toMatch(KEY_RULE);
      expect(d.idempotencyKey).not.toMatch(/admin-one|admin-two|example/);
      expect(d.idempotencyKey).toBe(idempotencyKeyFor(OCC, d.recipientKey));
    }
    expect(new Set(a.deliveries.map((d) => d.idempotencyKey)).size).toBe(2);
    expect(idempotencyKeyFor('admin-digest:2026-10-01T12:30:00.000Z', K1)).not.toBe(idempotencyKeyFor(OCC, K1));
  });

  it('the stored bytes are the body sendEmail would build for the same message (from, to, subject, html; no reply_to)', () => {
    const d = freezePlan(plan(), new Date(T0)).deliveries[0];
    const { from, to, subject, html } = d.payload;
    expect(d.payloadJson).toBe(JSON.stringify({ from, to, subject, html, reply_to: undefined }));
    expect(d.payloadJson).toBe(payloadJsonOf(d.payload));
  });
});

// ── The contract #677 asked for, at the engine ─────────────────────────────

describe('one occurrence, each recipient once', () => {
  it('delivers once to each recipient and reports the occurrence complete', async () => {
    const { provider, engine } = world();
    const r = await deliverDigestOccurrence(plan(), engine('a'));
    expect(r).toMatchObject({ created: true, planMismatch: null, complete: true, needsAttention: [], storageErrors: [] });
    expect(r.statuses).toEqual({ [K1]: 'accepted', [K2]: 'accepted' });
    expect(provider.deliveredTo(ONE)).toBe(1);
    expect(provider.deliveredTo(TWO)).toBe(1);
  });

  it('persists the key and the exact bytes, and marks the attempt, BEFORE the provider sees the request', async () => {
    const { store, provider, engine } = world();
    const seen: string[] = [];
    provider.onArrive = (req) => {
      const row = store.row(OCC, recipientKeyOf(req.to))!;
      expect(row.idempotencyKey).toBe(req.key);
      expect(row.payloadJson).toBe(req.payloadJson);
      expect(row.status).toBe('in_flight');
      expect(row.sendStartedAt).not.toBeNull();
      seen.push(req.to);
    };
    await deliverDigestOccurrence(plan(), engine('a'));
    expect(seen.sort()).toEqual([ONE, TWO]);
  });

  it('C1: a second call for the same occurrence sends nothing (sequential repeat)', async () => {
    const { provider, engine } = world();
    await deliverDigestOccurrence(plan(), engine('a'));
    const again = await deliverDigestOccurrence(plan(), engine('b'));
    expect(again.created).toBe(false);
    expect(again.attempts).toEqual([]);
    expect(provider.requests).toHaveLength(2);
    expect(provider.inbox).toHaveLength(2);
  });

  it('C2: two engine instances at once, interleaved at the provider: each recipient once', async () => {
    const { store, provider, engine } = world();
    const gate = deferred();
    provider.script = () => ({ do: 'delay_before_arrival', until: gate.promise, then: { do: 'accept' } });
    const a = deliverDigestOccurrence(plan(), engine('instance-a'));
    const b = deliverDigestOccurrence(plan(), engine('instance-b'));
    // Both recipients are on the wire at once, one from each instance.
    await vi.waitFor(() => expect(provider.requests).toHaveLength(2));
    expect(store.calls.filter((c) => c.method === 'claim').length).toBeGreaterThanOrEqual(3);
    gate.resolve();
    const [ra, rb] = await Promise.all([a, b]);
    expect(provider.inbox.map((d) => d.to).sort()).toEqual([ONE, TWO]);
    expect(provider.requests).toHaveLength(2);
    expect(ra.attempts).toHaveLength(1);
    expect(rb.attempts).toHaveLength(1);
    // Whoever lost a claim was told why, and sent nothing for it.
    for (const x of [...ra.refused, ...rb.refused]) expect(['leased', 'accepted']).toContain(x.reason);
  });

  it('C3: a retry after one recipient failed attempts ONLY that recipient', async () => {
    const { provider, engine } = world();
    provider.script = ({ to, n }) => (to === TWO && n === 1 ? { do: 'reject', status: 429, code: 'rate_limit_exceeded', retryable: true } : { do: 'accept' });
    const first = await deliverDigestOccurrence(plan(), engine('a'));
    expect(first.complete).toBe(false);
    expect(first.statuses).toEqual({ [K1]: 'accepted', [K2]: 'failed' });
    const retry = await deliverDigestOccurrence(plan(), engine('b'));
    expect(retry.attempts.map((x) => x.recipientKey)).toEqual([K2]);
    expect(retry.complete).toBe(true);
    expect(provider.requests.filter((r) => r.to === ONE)).toHaveLength(1);
    expect(provider.requests.filter((r) => r.to === TWO)).toHaveLength(2);
    expect(provider.deliveredTo(ONE)).toBe(1);
    expect(provider.deliveredTo(TWO)).toBe(1);
  });

  it('C4: an ambiguous send (accepted, answer lost) is retried with the SAME key and bytes; nobody else is re-sent', async () => {
    const { clock, provider, engine } = world();
    provider.script = ({ to, n }) => (to === ONE && n === 1 ? { do: 'accept_then_lose_answer', reason: 'timeout' } : { do: 'accept' });
    const first = await deliverDigestOccurrence(plan(), engine('a'));
    expect(first.statuses).toEqual({ [K1]: 'unknown', [K2]: 'accepted' });
    clock.advance(10 * MINUTE);
    const retry = await deliverDigestOccurrence(plan(), engine('b'));
    expect(retry.statuses).toEqual({ [K1]: 'accepted', [K2]: 'accepted' });
    const toOne = provider.requests.filter((r) => r.to === ONE);
    expect(toOne).toHaveLength(2);
    expect(new Set(toOne.map((r) => r.key)).size).toBe(1);
    expect(new Set(toOne.map((r) => r.payloadJson)).size).toBe(1);
    expect(provider.deliveredTo(ONE)).toBe(1); // the provider answered the retry with the original message
    expect(provider.requests.filter((r) => r.to === TWO)).toHaveLength(1);
  });
});

// ── Concurrency and leases ─────────────────────────────────────────────────

describe('concurrent claims and stale leases', () => {
  it('eight engines racing for one occurrence: one request per recipient in total', async () => {
    const { store, provider, engine } = world();
    const gate = deferred();
    provider.script = () => ({ do: 'delay_before_arrival', until: gate.promise, then: { do: 'accept' } });
    const runs = Array.from({ length: 8 }, (_, i) => deliverDigestOccurrence(plan(), engine(`e${i}`)));
    await vi.waitFor(() => expect(provider.requests).toHaveLength(2));
    gate.resolve();
    const reports = await Promise.all(runs);
    expect(provider.requests).toHaveLength(2);
    expect(provider.inbox).toHaveLength(2);
    expect(reports.filter((r) => r.created)).toHaveLength(1);
  });

  it('a worker that stalls past its lease: the next one takes over; the stale request is answered from the key; the stale receipt is fenced out', async () => {
    const { clock, store, provider, engine } = world();
    const stall = deferred();
    provider.script = ({ to, n }) => (to === ONE && n === 1 ? { do: 'delay_before_arrival', until: stall.promise, then: { do: 'accept' } } : { do: 'accept' });
    const a = deliverDigestOccurrence(plan(), engine('slow', { config: { ...CONFIG, sendTimeoutMs: 60_000 } }));
    await vi.waitFor(() => expect(provider.requests.some((q) => q.to === ONE)).toBe(true));
    clock.advance(5 * MINUTE); // A's lease lapses while its request is still on the wire
    const b = await deliverDigestOccurrence(plan(), engine('fresh'));
    expect(b.statuses).toEqual({ [K1]: 'accepted', [K2]: 'accepted' });
    const messageId = provider.inbox.find((d) => d.to === ONE)!.messageId;
    expect(store.row(OCC, K1)).toMatchObject({ status: 'accepted', fence: 2, providerMessageId: messageId });
    stall.resolve(); // A's request finally arrives: same key, same bytes
    const ra = await a;
    expect(ra.attempts.find((x) => x.recipientKey === K1)).toMatchObject({ fence: 1, result: 'accepted', recorded: 'fenced_out' });
    expect(provider.deliveredTo(ONE)).toBe(1);
    expect(store.row(OCC, K1)).toMatchObject({ status: 'accepted', fence: 2, providerMessageId: messageId });
  });

  it('while a stale request is still being processed, the new one is told it is in progress, stays unknown, and a later run settles it', async () => {
    const { clock, store, provider, engine } = world();
    const held = deferred();
    provider.script = ({ to, n }) => (to === ONE && n === 1 ? { do: 'hold_at_provider', until: held.promise, then: { do: 'accept' } } : { do: 'accept' });
    const a = deliverDigestOccurrence(plan(), engine('slow', { config: { ...CONFIG, sendTimeoutMs: 60_000 } }));
    await vi.waitFor(() => expect(provider.requests.some((q) => q.to === ONE)).toBe(true));
    clock.advance(5 * MINUTE);
    const b = await deliverDigestOccurrence(plan(), engine('fresh'));
    expect(b.attempts.find((x) => x.recipientKey === K1)).toMatchObject({ result: 'in_progress', recorded: 'ok' });
    expect(store.row(OCC, K1)).toMatchObject({ status: 'unknown', ambiguous: true });
    held.resolve();
    await a;
    clock.advance(10 * MINUTE);
    const c = await deliverDigestOccurrence(plan(), engine('later'));
    expect(c.statuses![K1]).toBe('accepted');
    expect(provider.deliveredTo(ONE)).toBe(1);
  });
});

describe('a worker that stalls between its claim and its mark', () => {
  it('is fenced out if another worker took over: it sends nothing', async () => {
    const { clock, store, provider, engine } = world();
    const stalled = deferred();
    let first = true;
    store.hooks.push(hookOn('beginSend', 'before', K1, async () => { if (first) { first = false; await stalled.promise; } }));
    const held = deferred();
    provider.script = ({ to }) => (to === ONE ? { do: 'hold_at_provider', until: held.promise, then: { do: 'accept' } } : { do: 'accept' });
    const a = deliverDigestOccurrence(plan({ recipients: [ONE] }), engine('stalled'));
    await vi.waitFor(() => expect(store.row(OCC, K1)?.status).toBe('in_flight'));
    clock.advance(5 * MINUTE);
    const b = deliverDigestOccurrence(plan({ recipients: [ONE] }), engine('takeover'));
    await vi.waitFor(() => expect(provider.requests).toHaveLength(1)); // B is at the provider, fence 2, in flight
    stalled.resolve();
    const ra = await a;
    expect(ra.attempts).toEqual([{ recipientKey: K1, fence: 1, result: 'not_sent', recorded: 'fenced_out', detail: 'fenced_out' }]);
    held.resolve();
    await b;
    expect(provider.requests).toHaveLength(1);
    expect(store.row(OCC, K1)).toMatchObject({ status: 'accepted', fence: 2 });
  });

  it('with no takeover and its lease gone, it still sends nothing; the next run sends once', async () => {
    const { clock, store, provider, engine } = world();
    const stalled = deferred();
    store.hooks.push(hookOn('beginSend', 'before', K1, () => stalled.promise));
    const a = deliverDigestOccurrence(plan({ recipients: [ONE] }), engine('stalled'));
    await vi.waitFor(() => expect(store.row(OCC, K1)?.status).toBe('in_flight'));
    clock.advance(5 * MINUTE);
    store.hooks = [];
    stalled.resolve();
    expect((await a).attempts).toEqual([{ recipientKey: K1, fence: 1, result: 'not_sent', recorded: 'not_sent', detail: 'lease_expired' }]);
    expect(provider.requests).toEqual([]);
    const next = await deliverDigestOccurrence(plan({ recipients: [ONE] }), engine('next'));
    expect(next.complete).toBe(true);
    expect(provider.requests).toHaveLength(1);
  });

  it('an ambiguous row claimed just inside the window but marked after the cut-off is parked, not sent', async () => {
    const { clock, store, provider, engine } = world();
    const long = { ...CONFIG, leaseMs: 2 * HOUR };
    provider.script = () => ({ do: 'lose_before_arrival', reason: 'timeout' });
    await deliverDigestOccurrence(plan({ recipients: [ONE] }), engine('a', { config: long })); // first mark at T0
    clock.set('2026-10-01T11:30:59.000Z'); // T0 + 23 h − 1 s: the claim is still allowed
    const stalled = deferred();
    store.hooks.push(hookOn('beginSend', 'before', K1, () => stalled.promise));
    const b = deliverDigestOccurrence(plan({ recipients: [ONE] }), engine('b', { config: long }));
    await vi.waitFor(() => expect(store.row(OCC, K1)?.status).toBe('in_flight'));
    clock.set('2026-10-01T11:31:00.000Z'); // the cut-off passes while it stalls
    store.hooks = [];
    stalled.resolve();
    expect((await b).attempts).toEqual([{ recipientKey: K1, fence: 2, result: 'not_sent', recorded: 'not_sent', detail: 'retention_passed' }]);
    expect(provider.requests).toHaveLength(1);
    expect(store.row(OCC, K1)!.status).toBe('needs_reconciliation');
  });
});

describe('a mark whose answer arrives late cannot send late (dispatch deadline)', () => {
  // 24 h retention, 1.5 s margin, 1 s send deadline, 5 min lease: a valid, deliberately tight config.
  const TIGHT: EngineConfig = { ...CONFIG, retentionSafetyMarginMs: 1_500, sendTimeoutMs: 1_000 };

  it('the mark commits 2 s before the cut-off but its answer arrives 2.5 s later: nothing is sent', async () => {
    const { clock, store, provider, engine } = world();
    provider.script = ({ n }) => (n === 1 ? { do: 'accept_then_lose_answer', reason: 'timeout' } : { do: 'accept' });
    await deliverDigestOccurrence(plan({ recipients: [ONE] }), engine('a', { config: TIGHT })); // first mark at T0; accepted, answer lost
    clock.set(new Date(Date.parse(T0) + 24 * HOUR - 2_000).toISOString());
    store.hooks.push(hookOn('beginSend', 'after', K1, () => { clock.advance(2_500); })); // committed; the answer is slow
    const r = await deliverDigestOccurrence(plan({ recipients: [ONE] }), engine('b', { config: TIGHT }));
    expect(r.attempts).toEqual([{ recipientKey: K1, fence: 2, result: 'not_sent', recorded: 'not_sent', detail: 'dispatch_deadline_passed' }]);
    expect(provider.requests).toHaveLength(1);
    expect(provider.inbox).toHaveLength(1);
  });

  it('a mark answer held past the cut-off while a recovery worker parks the row: the stalled worker still sends nothing', async () => {
    const { clock, store, provider, engine } = world();
    provider.script = ({ n }) => (n === 1 ? { do: 'accept_then_lose_answer', reason: 'timeout' } : { do: 'accept' });
    await deliverDigestOccurrence(plan({ recipients: [ONE] }), engine('a')); // first mark at T0
    clock.set(new Date(Date.parse(T0) + 22 * HOUR).toISOString());
    const entered = deferred();
    const release = deferred();
    store.hooks.push(hookOn('beginSend', 'after', K1, async () => { entered.resolve(); await release.promise; }));
    const stalled = deliverDigestOccurrence(plan({ recipients: [ONE] }), engine('stalled'));
    await entered.promise; // the mark is committed; its answer is held
    store.hooks = [];
    clock.set(new Date(Date.parse(T0) + 25 * HOUR).toISOString());
    const recovery = await deliverDigestOccurrence(plan({ recipients: [ONE] }), engine('recovery'));
    expect(recovery.needsAttention).toEqual([{ recipientKey: K1, status: 'needs_reconciliation' }]);
    release.resolve();
    const s = await stalled;
    expect(s.attempts).toEqual([{ recipientKey: K1, fence: 2, result: 'not_sent', recorded: 'not_sent', detail: 'dispatch_deadline_passed' }]);
    expect(provider.requests).toHaveLength(1);
    expect(provider.inbox).toHaveLength(1);
  });

  it('control: a mark answer that is slow but inside the deadline still sends, once', async () => {
    const { clock, store, provider, engine } = world();
    store.hooks.push(hookOn('beginSend', 'after', K1, () => { clock.advance(4 * MINUTE); })); // lease 5 min, send deadline 150 ms
    const r = await deliverDigestOccurrence(plan({ recipients: [ONE] }), engine('a'));
    expect(r.complete).toBe(true);
    expect(provider.inbox).toHaveLength(1);
  });

  it('control: past the LEASE part of the deadline (not retention) nothing is sent either', async () => {
    const { clock, store, provider, engine } = world();
    store.hooks.push(hookOn('beginSend', 'after', K1, () => { clock.advance(5 * MINUTE - 100); })); // 100 ms of lease left < 150 ms send deadline
    const r = await deliverDigestOccurrence(plan({ recipients: [ONE] }), engine('a'));
    expect(r.attempts[0]).toMatchObject({ result: 'not_sent', detail: 'dispatch_deadline_passed' });
    expect(provider.requests).toEqual([]);
  });
});

describe('attempts are bounded even when no attempt ever completes', () => {
  it('five claims that each die before the mark: the sixth parks the recipient as exhausted, and nothing was sent', async () => {
    const { clock, store, provider, engine } = world();
    store.hooks.push(hookOn('claim', 'after', K1, never));
    for (let i = 1; i <= CONFIG.maxAttempts; i += 1) {
      void deliverDigestOccurrence(plan({ recipients: [ONE] }), engine(`dies-${i}`));
      await vi.waitFor(() => expect(store.row(OCC, K1)?.attempts).toBe(i));
      clock.advance(5 * MINUTE);
    }
    store.hooks = [];
    const r = await deliverDigestOccurrence(plan({ recipients: [ONE] }), engine('last'));
    expect(r.refused).toEqual([{ recipientKey: K1, reason: 'exhausted' }]);
    expect(r.needsAttention).toEqual([{ recipientKey: K1, status: 'exhausted' }]);
    expect(provider.requests).toEqual([]);
  });
});

describe('a stale receipt while the row is in flight under a newer claim', () => {
  it('is fenced out: it cannot overwrite the newer claim, which then settles on its own', async () => {
    const { clock, store, provider, engine } = world();
    const aWire = deferred();
    const bHeld = deferred();
    provider.script = ({ n }) => (n === 1
      ? { do: 'delay_before_arrival', until: aWire.promise, then: { do: 'accept' } }
      : { do: 'hold_at_provider', until: bHeld.promise, then: { do: 'accept' } });
    const a = deliverDigestOccurrence(plan({ recipients: [ONE] }), engine('slow', { config: { ...CONFIG, sendTimeoutMs: 60_000 } }));
    await vi.waitFor(() => expect(provider.requests).toHaveLength(1));
    clock.advance(5 * MINUTE);
    const b = deliverDigestOccurrence(plan({ recipients: [ONE] }), engine('fresh', { config: { ...CONFIG, sendTimeoutMs: 60_000 } }));
    await vi.waitFor(() => expect(provider.requests).toHaveLength(2)); // B holds the key at the provider, row in flight at fence 2
    aWire.resolve(); // A's request arrives while B's is in progress: 409 concurrent, and A's receipt meets fence 2
    const ra = await a;
    expect(ra.attempts).toEqual([{ recipientKey: K1, fence: 1, result: 'in_progress', recorded: 'fenced_out' }]);
    expect(store.row(OCC, K1)).toMatchObject({ status: 'in_flight', fence: 2 });
    bHeld.resolve();
    await b;
    expect(store.row(OCC, K1)).toMatchObject({ status: 'accepted', fence: 2 });
    expect(provider.deliveredTo(ONE)).toBe(1);
  });
});

// ── Crashes and restarts ───────────────────────────────────────────────────

describe('crashes and restarts from saved state', () => {
  it('restart: a new process with only the saved state resumes, never re-sends the accepted, and sends the rest with the frozen bytes', async () => {
    const { clock, store, provider, engine } = world();
    store.hooks.push(hookOn('claim', 'before', SECOND.key, never)); // the first process dies before its second claim
    void deliverDigestOccurrence(plan(), engine('first'));
    await vi.waitFor(() => expect(store.row(OCC, FIRST.key)?.status).toBe('accepted'));
    const saved = store.snapshot();
    const restarted = MemoryDigestDeliveryStore.restore(saved, clock.now);
    const r = await resumeDigestOccurrence(OCC, { store: restarted, provider, owner: 'second', config: CONFIG, now: clock.now });
    expect(r.attempts.map((x) => x.recipientKey)).toEqual([SECOND.key]);
    expect(r.complete).toBe(true);
    expect(provider.inbox.find((d) => d.to === SECOND.to)!.payloadJson).toBe(freezePlan(plan(), new Date(T0)).deliveries.find((d) => d.recipientKey === SECOND.key)!.payloadJson);
    expect(provider.inbox).toHaveLength(2);
  });

  it('crash right after the claim, before the mark: nothing can have been sent, so it is retried even days later', async () => {
    const { clock, store, provider, engine } = world();
    store.hooks.push(hookOn('claim', 'after', K1, never));
    void deliverDigestOccurrence(plan(), engine('dies'));
    await vi.waitFor(() => expect(store.row(OCC, K1)?.status).toBe('in_flight'));
    store.hooks = [];
    clock.advance(3 * 24 * HOUR);
    const r = await deliverDigestOccurrence(plan(), engine('next'));
    expect(r.statuses).toEqual({ [K1]: 'accepted', [K2]: 'accepted' });
    expect(store.row(OCC, K1)).toMatchObject({ ambiguous: false, attempts: 2 });
    expect(provider.deliveredTo(ONE)).toBe(1);
  });

  it('crash after the mark, before the provider call: treated as possibly sent, retried with the same key inside the window', async () => {
    const { clock, store, provider, engine } = world();
    store.hooks.push(hookOn('beginSend', 'after', K1, never));
    void deliverDigestOccurrence(plan(), engine('dies'));
    await vi.waitFor(() => expect(typeof store.row(OCC, K1)?.sendStartedAt).toBe('string'));
    store.hooks = [];
    clock.advance(6 * MINUTE);
    const r = await deliverDigestOccurrence(plan(), engine('next'));
    expect(store.row(OCC, K1)).toMatchObject({ status: 'accepted', ambiguous: true });
    expect(r.complete).toBe(true);
    expect(provider.requests.filter((q) => q.to === ONE)).toHaveLength(1);
    expect(provider.deliveredTo(ONE)).toBe(1);
  });

  it('crash after the provider accepted, before the receipt: the retry reuses the key and gets the original message back', async () => {
    const { clock, store, provider, engine } = world();
    store.hooks.push(hookOn('complete', 'before', K1, never));
    void deliverDigestOccurrence(plan(), engine('dies'));
    await vi.waitFor(() => expect(provider.deliveredTo(ONE)).toBe(1));
    store.hooks = [];
    clock.advance(6 * MINUTE);
    const r = await deliverDigestOccurrence(plan(), engine('next'));
    expect(store.row(OCC, K1)).toMatchObject({ status: 'accepted', providerMessageId: provider.inbox.find((d) => d.to === ONE)!.messageId });
    expect(r.complete).toBe(true);
    const toOne = provider.requests.filter((q) => q.to === ONE);
    expect(toOne).toHaveLength(2);
    expect(new Set(toOne.map((q) => `${q.key}|${q.payloadJson}`)).size).toBe(1);
    expect(provider.deliveredTo(ONE)).toBe(1);
  });
});

// ── Partial failure ────────────────────────────────────────────────────────

describe('partial failure', () => {
  it('a permanent refusal parks that recipient as rejected; the other is delivered; nothing is retried for it', async () => {
    const { provider, engine } = world();
    provider.script = ({ to }) => (to === TWO ? { do: 'reject', status: 422, code: 'validation_error', retryable: false } : { do: 'accept' });
    const r = await deliverDigestOccurrence(plan(), engine('a'));
    expect(r).toMatchObject({ complete: false, needsAttention: [{ recipientKey: K2, status: 'rejected' }] });
    const again = await deliverDigestOccurrence(plan(), engine('b'));
    expect(again.attempts).toEqual([]);
    expect(provider.requests.filter((q) => q.to === TWO)).toHaveLength(1);
  });

  it('a refusal after an earlier ambiguous attempt is NOT reported as undelivered: it needs reconciliation', async () => {
    const { clock, provider, engine } = world();
    provider.script = ({ n }) => (n === 1 ? { do: 'lose_before_arrival', reason: 'timeout' } : { do: 'reject', status: 422, code: 'validation_error', retryable: false });
    await deliverDigestOccurrence(plan({ recipients: [ONE] }), engine('a'));
    clock.advance(10 * MINUTE);
    const r = await deliverDigestOccurrence(plan({ recipients: [ONE] }), engine('b'));
    expect(r.needsAttention).toEqual([{ recipientKey: K1, status: 'needs_reconciliation' }]);
  });

  it('retryable refusals are bounded: after maxAttempts the recipient is exhausted (nothing was ever possibly accepted)', async () => {
    const { clock, provider, engine } = world();
    provider.script = () => ({ do: 'reject', status: 429, code: 'rate_limit_exceeded', retryable: true });
    for (let i = 0; i < 7; i += 1) { await deliverDigestOccurrence(plan({ recipients: [ONE] }), engine(`r${i}`)); clock.advance(MINUTE); }
    expect(provider.requests).toHaveLength(CONFIG.maxAttempts);
    const r = await resumeDigestOccurrence(OCC, engine('last'));
    expect(r.needsAttention).toEqual([{ recipientKey: K1, status: 'exhausted' }]);
  });

  it('ambiguous outcomes are bounded too: after maxAttempts the recipient needs reconciliation, never "exhausted"', async () => {
    const { clock, provider, engine } = world();
    provider.script = () => ({ do: 'lose_before_arrival', reason: 'network' });
    for (let i = 0; i < 7; i += 1) { await deliverDigestOccurrence(plan({ recipients: [ONE] }), engine(`r${i}`)); clock.advance(MINUTE); }
    expect(provider.requests).toHaveLength(CONFIG.maxAttempts);
    expect(new Set(provider.requests.map((q) => q.key)).size).toBe(1);
    const r = await resumeDigestOccurrence(OCC, engine('last'));
    expect(r.needsAttention).toEqual([{ recipientKey: K1, status: 'needs_reconciliation' }]);
  });
});

// ── Storage failures ───────────────────────────────────────────────────────

describe('storage failures', () => {
  it('freeze fails: nothing is sent', async () => {
    const { store, provider, engine } = world();
    store.hooks.push(hookOn('freeze', 'before', null, fail));
    const r = await deliverDigestOccurrence(plan(), engine('a'));
    expect(r.storageErrors).toEqual([{ stage: 'freeze' }]);
    expect(provider.requests).toEqual([]);
  });

  it('freeze commits but its answer is lost: nothing is sent now; the next run finds the plan and delivers once', async () => {
    const { store, provider, engine } = world();
    store.hooks.push(hookOn('freeze', 'after', null, fail));
    await deliverDigestOccurrence(plan(), engine('a'));
    expect(provider.requests).toEqual([]);
    store.hooks = [];
    const r = await deliverDigestOccurrence(plan(), engine('b'));
    expect(r).toMatchObject({ created: false, complete: true });
    expect(provider.inbox).toHaveLength(2);
  });

  it('resume cannot load: nothing is sent', async () => {
    const { store, provider, engine } = world();
    await deliverDigestOccurrence(plan({ recipients: [ONE] }), engine('a'));
    store.hooks.push(hookOn('load', 'before', null, fail));
    const r = await resumeDigestOccurrence(OCC, engine('b'));
    expect(r.storageErrors).toEqual([{ stage: 'load' }]);
    expect(provider.requests).toHaveLength(1);
  });

  // Failures are injected on the recipient the engine visits FIRST, so "the other still is" is shown, not assumed.
  it('a claim fails (before or after it committed): that recipient is not sent this run; the other still is; a later run completes once', async () => {
    for (const phase of ['before', 'after'] as const) {
      const { clock, store, provider, engine } = world();
      store.hooks.push(hookOn('claim', phase, FIRST.key, fail));
      const r = await deliverDigestOccurrence(plan(), engine('a'));
      expect(r.storageErrors).toEqual([{ stage: 'claim', recipientKey: FIRST.key }]);
      expect(provider.requests.map((q) => q.to)).toEqual([SECOND.to]);
      store.hooks = [];
      clock.advance(6 * MINUTE);
      expect((await deliverDigestOccurrence(plan(), engine('b'))).complete).toBe(true);
      expect(provider.inbox).toHaveLength(2);
    }
  });

  it('the mark fails (before or after it committed): nothing is sent for that recipient this run', async () => {
    for (const phase of ['before', 'after'] as const) {
      const { clock, store, provider, engine } = world();
      store.hooks.push(hookOn('beginSend', phase, FIRST.key, fail));
      await deliverDigestOccurrence(plan(), engine('a'));
      expect(provider.requests.map((q) => q.to)).toEqual([SECOND.to]);
      store.hooks = [];
      clock.advance(6 * MINUTE);
      expect((await deliverDigestOccurrence(plan(), engine('b'))).complete).toBe(true);
      expect(store.row(OCC, FIRST.key)!.ambiguous).toBe(phase === 'after'); // a committed mark is honestly ambiguous
      expect(provider.deliveredTo(FIRST.to)).toBe(1);
    }
  });

  it('the receipt write fails after the provider accepted: reported as unconfirmed with the message id, and the retry is answered from the key', async () => {
    const { clock, store, provider, engine } = world();
    store.hooks.push(hookOn('complete', 'before', K1, fail));
    const r = await deliverDigestOccurrence(plan(), engine('a'));
    expect(r.attempts.find((x) => x.recipientKey === K1)).toEqual({
      recipientKey: K1, fence: 1, result: 'accepted', recorded: 'receipt_write_unconfirmed', messageId: provider.inbox.find((d) => d.to === ONE)!.messageId,
    });
    expect(r.complete).toBe(false);
    expect(store.row(OCC, K1)!.status).toBe('in_flight');
    store.hooks = [];
    expect((await deliverDigestOccurrence(plan(), engine('b'))).attempts).toEqual([]); // the lease still holds
    clock.advance(5 * MINUTE);
    const later = await deliverDigestOccurrence(plan(), engine('c'));
    expect(later.complete).toBe(true);
    expect(store.row(OCC, K1)).toMatchObject({ status: 'accepted', providerMessageId: provider.inbox.find((d) => d.to === ONE)!.messageId });
    expect(provider.deliveredTo(ONE)).toBe(1);
  });

  it('the receipt write committed but its answer was lost: the next run sees it accepted and sends nothing', async () => {
    const { store, provider, engine } = world();
    store.hooks.push(hookOn('complete', 'after', K1, fail));
    await deliverDigestOccurrence(plan(), engine('a'));
    store.hooks = [];
    const r = await deliverDigestOccurrence(plan(), engine('b'));
    expect(r.attempts).toEqual([]);
    expect(provider.requests).toHaveLength(2);
  });
});

// ── Payload changes and conflicts ──────────────────────────────────────────

describe('changed payloads and provider conflicts', () => {
  it('a retry whose recomputed digest differs sends the FROZEN bytes, and says the plan differed', async () => {
    const { clock, provider, engine } = world();
    provider.script = ({ to, n }) => (to === TWO && n === 1 ? { do: 'reject', status: 429, code: 'rate_limit_exceeded', retryable: true } : { do: 'accept' });
    await deliverDigestOccurrence(plan(), engine('a'));
    clock.advance(30 * MINUTE);
    const changed = plan({
      recipients: [ONE, TWO, 'admin-three@example.test'],
      payload: { ...plan().payload, html: '<p>3 new families (a row committed late).</p>' },
    });
    const r = await deliverDigestOccurrence(changed, engine('b'));
    expect(r.planMismatch).toEqual({ recipientsAdded: 1, recipientsRemoved: 0, payloadChanged: true, windowChanged: false });
    const toTwo = provider.requests.filter((q) => q.to === TWO);
    expect(toTwo).toHaveLength(2);
    expect(new Set(toTwo.map((q) => q.payloadJson)).size).toBe(1);
    expect(toTwo[1].payloadJson).toContain('2 new families.');
    expect(provider.requests.some((q) => q.to === 'admin-three@example.test')).toBe(false);
    expect(r.complete).toBe(true);
  });

  it('a retry that names a different window for the same occurrence is reported, and the stored window stands', async () => {
    const { engine } = world();
    await deliverDigestOccurrence(plan(), engine('a'));
    const r = await deliverDigestOccurrence(plan({ window: { start: '2026-09-29T12:33:00.000Z', end: '2026-09-30T12:33:00.000Z' } }), engine('b'));
    expect(r.planMismatch).toEqual({ recipientsAdded: 0, recipientsRemoved: 0, payloadChanged: false, windowChanged: true });
    expect(r.attempts).toEqual([]);
  });

  it('409 invalid_idempotent_request: a conflict, parked, never retried and never re-keyed', async () => {
    const { clock, provider, engine } = world();
    const row = freezePlan(plan(), new Date(T0)).deliveries.find((d) => d.recipientKey === K1)!;
    provider.preuse(row.idempotencyKey, JSON.stringify({ ...row.payload, html: '<p>what the old sender sent</p>' }));
    const r = await deliverDigestOccurrence(plan(), engine('a'));
    expect(r.needsAttention).toEqual([{ recipientKey: K1, status: 'conflict' }]);
    expect(r.attempts.find((x) => x.recipientKey === K1)!.result).toBe('payload_conflict');
    for (let i = 0; i < 3; i += 1) { clock.advance(HOUR); await deliverDigestOccurrence(plan(), engine(`later-${i}`)); }
    const toOne = provider.requests.filter((q) => q.to === ONE);
    expect(toOne).toHaveLength(1);
    expect(toOne[0].key).toBe(row.idempotencyKey);
    expect(provider.deliveredTo(ONE)).toBe(0);
  });
});

// ── The provider's retention window ───────────────────────────────────────

describe('the provider\'s key retention window', () => {
  it('an unknown outcome is retried under the same key only while the provider still remembers it; then parked for reconciliation', async () => {
    const { clock, provider, engine } = world();
    provider.script = () => ({ do: 'lose_before_arrival', reason: 'timeout' });
    await deliverDigestOccurrence(plan({ recipients: [ONE] }), engine('a')); // first beginSend at T0
    clock.set('2026-10-01T11:30:59.999Z'); // T0 + 23 h − 1 ms: still inside (24 h − 1 h margin)
    await deliverDigestOccurrence(plan({ recipients: [ONE] }), engine('b'));
    expect(provider.requests).toHaveLength(2);
    clock.set('2026-10-01T11:31:00.000Z'); // T0 + 23 h: no longer safe
    const r = await deliverDigestOccurrence(plan({ recipients: [ONE] }), engine('c'));
    expect(r.refused).toEqual([{ recipientKey: K1, reason: 'needs_reconciliation' }]);
    expect(r.needsAttention).toEqual([{ recipientKey: K1, status: 'needs_reconciliation' }]);
    clock.set('2026-10-03T00:00:00.000Z');
    await deliverDigestOccurrence(plan({ recipients: [ONE] }), engine('d'));
    expect(provider.requests).toHaveLength(2);
    expect(new Set(provider.requests.map((q) => q.key)).size).toBe(1);
  });

  it('why: the provider forgets keys after 24 h, so a retry after that would deliver a second copy of an accepted message', async () => {
    const { clock, provider, engine } = world();
    provider.script = ({ n }) => (n === 1 ? { do: 'accept_then_lose_answer', reason: 'timeout' } : { do: 'accept' });
    await deliverDigestOccurrence(plan({ recipients: [ONE] }), engine('a'));
    expect(provider.deliveredTo(ONE)).toBe(1);
    clock.set('2026-10-01T13:00:00.000Z'); // T0 + 24 h 29 min: the fake provider no longer knows the key
    const r = await deliverDigestOccurrence(plan({ recipients: [ONE] }), engine('b'));
    expect(r.needsAttention).toEqual([{ recipientKey: K1, status: 'needs_reconciliation' }]);
    expect(provider.requests).toHaveLength(1);
    expect(provider.deliveredTo(ONE)).toBe(1);
  });

  it('a delivery that was only ever definitively refused is safe to retry at any age', async () => {
    const { clock, provider, engine } = world();
    provider.script = ({ n }) => (n === 1 ? { do: 'reject', status: 401, code: 'missing_api_key', retryable: true } : { do: 'accept' });
    await deliverDigestOccurrence(plan({ recipients: [ONE] }), engine('a'));
    clock.set('2026-10-02T18:00:00.000Z'); // T0 + 53 h
    const r = await deliverDigestOccurrence(plan({ recipients: [ONE] }), engine('b'));
    expect(r.complete).toBe(true);
    expect(provider.deliveredTo(ONE)).toBe(1);
  });
});

// ── What counts as an answer ───────────────────────────────────────────────

describe('what the provider said, taken at its word and no further', () => {
  it('a 2xx without a message id is not a receipt', async () => {
    const { store, provider, engine } = world();
    provider.script = () => ({ do: 'accept_without_id' });
    await deliverDigestOccurrence(plan({ recipients: [ONE] }), engine('a'));
    expect(store.row(OCC, K1)).toMatchObject({ status: 'unknown', ambiguous: true, providerMessageId: null });
  });

  it('a provider that throws settles nothing', async () => {
    const { store, provider, engine } = world();
    provider.script = () => ({ do: 'throw' });
    await deliverDigestOccurrence(plan({ recipients: [ONE] }), engine('a'));
    expect(store.row(OCC, K1)).toMatchObject({ status: 'unknown', ambiguous: true, lastError: 'outcome_unknown:network' });
  });

  it('the engine\'s own deadline: the request is aborted and the outcome is unknown, not failed', async () => {
    const { store, provider, engine } = world();
    let aborted = false;
    provider.send = async (req) => { req.signal.addEventListener('abort', () => { aborted = true; }); return never(); };
    const r = await deliverDigestOccurrence(plan({ recipients: [ONE] }), engine('a'));
    expect(aborted).toBe(true);
    expect(r.attempts[0]).toMatchObject({ result: 'unknown', recorded: 'ok' });
    expect(store.row(OCC, K1)).toMatchObject({ status: 'unknown', ambiguous: true, lastError: 'outcome_unknown:timeout' });
  });

  it('a stored payload that no longer matches its hash is never sent', async () => {
    const { store, provider, engine } = world();
    await deliverDigestOccurrence(plan({ recipients: [ONE] }), { ...engine('a'), provider: { send: async () => ({ kind: 'unknown', reason: 'timeout' }) } });
    store.tamper(OCC, K1, (row) => { row.payloadJson = row.payloadJson.replace('2 new families', '9 new families'); row.status = 'failed'; row.ambiguous = false; });
    const r = await deliverDigestOccurrence(plan({ recipients: [ONE] }), engine('b'));
    expect(r.attempts[0]).toMatchObject({ result: 'not_sent', detail: 'stored_payload_integrity_failed' });
    expect(provider.requests).toEqual([]);
  });

  it('an adapter that calls a 5xx "rejected" has settled nothing: the row is unknown, not failed', async () => {
    const { store, engine } = world();
    await deliverDigestOccurrence(plan({ recipients: [ONE] }), {
      ...engine('a'), provider: { send: async () => ({ kind: 'rejected', httpStatus: 503, code: 'x', retryable: true }) },
    });
    expect(store.row(OCC, K1)).toMatchObject({ status: 'unknown', ambiguous: true });
  });

  it('after an ambiguous attempt, a retryable refusal leaves the row unknown (still bounded by retention), not "failed"', async () => {
    const { clock, store, provider, engine } = world();
    provider.script = ({ n }) => (n === 1 ? { do: 'lose_before_arrival', reason: 'timeout' } : { do: 'reject', status: 429, code: 'rate_limit_exceeded', retryable: true });
    await deliverDigestOccurrence(plan({ recipients: [ONE] }), engine('a'));
    clock.advance(HOUR);
    await deliverDigestOccurrence(plan({ recipients: [ONE] }), engine('b'));
    expect(store.row(OCC, K1)).toMatchObject({ status: 'unknown', ambiguous: true });
    clock.set('2026-10-01T11:31:00.000Z');
    const r = await deliverDigestOccurrence(plan({ recipients: [ONE] }), engine('c'));
    expect(r.needsAttention).toEqual([{ recipientKey: K1, status: 'needs_reconciliation' }]);
    expect(provider.requests).toHaveLength(2);
  });

  it('a stored key or recipient that no longer matches what was frozen is never sent', async () => {
    for (const change of ['key', 'recipient'] as const) {
      const { store, provider, engine } = world();
      await deliverDigestOccurrence(plan({ recipients: [ONE] }), { ...engine('a'), provider: { send: async () => ({ kind: 'rejected', httpStatus: 429, code: 'x', retryable: true }) } });
      store.tamper(OCC, K1, (row) => {
        if (change === 'key') row.idempotencyKey = 'bubaly/admin-digest/v1/rotated';
        else {
          row.payload = { ...row.payload, to: 'someone-else@example.test' };
          row.payloadJson = payloadJsonOf(row.payload);
          row.payloadHash = createHash('sha256').update(row.payloadJson).digest('hex');
        }
      });
      const r = await deliverDigestOccurrence(plan({ recipients: [ONE] }), engine('b'));
      expect(r.attempts[0]).toMatchObject({ result: 'not_sent', detail: 'stored_payload_integrity_failed' });
      expect(provider.requests).toEqual([]);
    }
  });

  it('when the final read fails the run is not reported complete, even though it sent', async () => {
    const { store, provider, engine } = world();
    store.hooks.push(hookOn('load', 'before', null, fail));
    const r = await deliverDigestOccurrence(plan(), engine('a'));
    expect(provider.inbox).toHaveLength(2);
    expect(r).toMatchObject({ complete: false, statuses: null, storageErrors: [{ stage: 'final_load' }] });
  });

  it('every accepted attempt carries its message id in the report', async () => {
    const { provider, engine } = world();
    const r = await deliverDigestOccurrence(plan(), engine('a'));
    expect(r.attempts.map((x) => x.messageId).sort()).toEqual(provider.inbox.map((d) => d.messageId).sort());
  });

  it.each<[number, unknown, string]>([
    [200, { id: 'e1' }, 'accepted'],
    [200, {}, 'unknown'],
    [409, { name: 'invalid_idempotent_request' }, 'payload_conflict'],
    [409, { name: 'concurrent_idempotent_requests' }, 'in_progress'],
    [409, {}, 'unknown'],
    [429, { name: 'rate_limit_exceeded' }, 'rejected:retryable'],
    [401, { name: 'missing_api_key' }, 'rejected:retryable'],
    [403, { name: 'validation_error' }, 'rejected:retryable'],
    [400, { name: 'invalid_idempotency_key' }, 'rejected:final'],
    [422, { name: 'validation_error' }, 'rejected:final'],
    [500, { name: 'internal_server_error' }, 'unknown'],
    [503, null, 'unknown'],
  ])('Resend %i %j → %s', (status, body, expected) => {
    const r = classifyResendResponse(status, body);
    const got = r.kind === 'rejected' ? `rejected:${r.retryable ? 'retryable' : 'final'}` : r.kind;
    expect(got).toBe(expected);
  });
});
