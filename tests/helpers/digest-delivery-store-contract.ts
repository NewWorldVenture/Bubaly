// The executable half of the storage contract for lib/admin/digest-delivery.ts.
// Any DigestDeliveryStore must pass it: today the in-memory store; a PostgreSQL
// adapter later, run against the local stack. Passing it with the in-memory
// store proves the rules, not database durability or isolation.
//
// Time: every lease and retention decision is the STORE's, on the store's
// clock. `make(clock)` must return a store whose clock follows `clock`; for a
// database adapter that means the harness pins the database's notion of now
// (the adapter's SQL reads time through one function the harness can replace).
import { describe, expect, it } from 'vitest';
import {
  freezePlan, recipientKeyOf, RESEND_KEY_RETENTION_MS,
  type Admission, type BeginSendPolicy, type ClaimPolicy, type DigestDeliveryStore, type OccurrencePlan,
} from '@/lib/admin/digest-delivery';
import { FakeClock, HOUR, MINUTE } from './digest-delivery-fakes';

export const CONTRACT_POLICY: ClaimPolicy = {
  leaseMs: 5 * MINUTE, maxAttempts: 3, providerKeyRetentionMs: RESEND_KEY_RETENTION_MS, retentionSafetyMarginMs: HOUR,
};

export const CONTRACT_BEGIN: BeginSendPolicy = {
  minLeaseRemainingMs: 1_000, providerKeyRetentionMs: RESEND_KEY_RETENTION_MS, retentionSafetyMarginMs: HOUR,
};

/** An admission for a recipient on the code/config allowlist: eligible whatever super_admins holds. */
export const ADMITTED: Admission = { allowlisted: true };
/** An admission for a recipient who is eligible only if the store's super_admins lists them. */
export const TABLE_ONLY: Admission = { allowlisted: false };

/**
 * The store's super_admins table, as the contract drives it (0474 reads it at admission). Each test
 * starts with it empty and readable.
 */
export type ContractAdminTable = {
  /** Replace the table's rows with these raw addresses. */
  set(emails: readonly string[]): Promise<void>;
  /** Make the table unreadable until the next test. */
  breakTable(): Promise<void>;
};

/** 'ok' or the refusal, for assertions. */
export const answerOf = (a: { ok: true } | { ok: false; reason: string }) => (a.ok ? 'ok' : a.reason);

export const contractPlan = (over: Partial<OccurrencePlan> = {}): OccurrencePlan => ({
  occurrenceId: 'admin-digest:2026-09-30T12:30:00.000Z',
  window: { start: '2026-09-29T12:30:00.000Z', end: '2026-09-30T12:30:00.000Z' },
  recipients: ['admin-one@example.test', 'admin-two@example.test'],
  payload: { from: 'Bubaly <digest@example.test>', subject: '[Bubaly] Daily digest · synthetic', html: '<p>2 new families.</p>' },
  ...over,
});

export function describeDigestDeliveryStoreContract(label: string, make: (clock: FakeClock) => DigestDeliveryStore, admins: () => ContractAdminTable) {
  describe(`${label}: DigestDeliveryStore contract`, () => {
    const start = '2026-09-30T12:31:00.000Z';
    const setup = async () => {
      const clock = new FakeClock(start);
      const store = make(clock);
      const frozen = freezePlan(contractPlan(), clock.now());
      await store.freeze(frozen.occurrence, frozen.deliveries);
      const id = frozen.occurrence.occurrenceId;
      const key = recipientKeyOf('admin-one@example.test');
      return { clock, store, frozen, id, key };
    };

    it('freeze stores the occurrence and every delivery, all pending, and returns what is stored', async () => {
      const clock = new FakeClock(start);
      const store = make(clock);
      const frozen = freezePlan(contractPlan(), clock.now());
      const out = await store.freeze(frozen.occurrence, frozen.deliveries);
      expect(out.created).toBe(true);
      expect(out.occurrence).toEqual(frozen.occurrence);
      expect(out.deliveries).toEqual(frozen.deliveries);
      expect(await store.load(frozen.occurrence.occurrenceId)).toEqual({ occurrence: frozen.occurrence, deliveries: frozen.deliveries });
    });

    it('a second freeze of a DIFFERENT plan for the same occurrence changes nothing and returns the first', async () => {
      const { clock, store, frozen, id } = await setup();
      const other = freezePlan(contractPlan({ recipients: ['admin-three@example.test'], payload: { ...contractPlan().payload, html: '<p>changed</p>' } }), clock.now());
      const out = await store.freeze(other.occurrence, other.deliveries);
      expect(out.created).toBe(false);
      expect(out.occurrence).toEqual(frozen.occurrence);
      expect(out.deliveries.map((d) => d.payloadJson)).toEqual(frozen.deliveries.map((d) => d.payloadJson));
      expect((await store.load(id))!.deliveries).toHaveLength(2);
    });

    it('concurrent freezes of two different plans: exactly one is stored, and both callers are told the same thing', async () => {
      const clock = new FakeClock(start);
      const store = make(clock);
      const a = freezePlan(contractPlan(), clock.now());
      const b = freezePlan(contractPlan({ payload: { ...contractPlan().payload, html: '<p>b</p>' } }), clock.now());
      const [ra, rb] = await Promise.all([store.freeze(a.occurrence, a.deliveries), store.freeze(b.occurrence, b.deliveries)]);
      expect([ra.created, rb.created].filter(Boolean)).toHaveLength(1);
      expect(ra.occurrence).toEqual(rb.occurrence);
      expect(ra.deliveries).toEqual(rb.deliveries);
    });

    it('load hands out copies: changing a returned row changes nothing stored', async () => {
      const { store, id } = await setup();
      const first = (await store.load(id))!;
      first.deliveries[0].payload.html = 'mutated';
      first.deliveries[0].status = 'accepted';
      const again = (await store.load(id))!;
      expect(again.deliveries[0].payload.html).toBe('<p>2 new families.</p>');
      expect(again.deliveries[0].status).toBe('pending');
    });

    it('claim is atomic: twelve concurrent claims of one delivery, exactly one wins, with fence 1 and attempt 1', async () => {
      const { store, id, key } = await setup();
      const results = await Promise.all(Array.from({ length: 12 }, (_, i) => store.claim(id, key, `worker-${i}`, CONTRACT_POLICY)));
      const won = results.filter((r) => r.claimed);
      expect(won).toHaveLength(1);
      expect(results.filter((r) => !r.claimed && r.reason === 'leased')).toHaveLength(11);
      const row = (await store.load(id))!.deliveries.find((d) => d.recipientKey === key)!;
      expect(row).toMatchObject({ status: 'in_flight', fence: 1, attempts: 1 });
    });

    it('a live lease refuses; it expires by the STORE\'s clock, and the next claim gets a new fence', async () => {
      const { clock, store, id, key } = await setup();
      expect((await store.claim(id, key, 'a', CONTRACT_POLICY)).claimed).toBe(true);
      clock.advance(5 * MINUTE - 1);
      expect(await store.claim(id, key, 'b', CONTRACT_POLICY)).toEqual({ claimed: false, reason: 'leased' });
      clock.advance(1);
      const b = await store.claim(id, key, 'b', CONTRACT_POLICY);
      expect(b.claimed && b.row.fence).toBe(2);
    });

    it('beginSend and complete are fenced: a superseded claim writes nothing', async () => {
      const { clock, store, id, key } = await setup();
      const a = await store.claim(id, key, 'a', CONTRACT_POLICY);
      clock.advance(5 * MINUTE);
      const b = await store.claim(id, key, 'b', CONTRACT_POLICY);
      if (!a.claimed || !b.claimed) throw new Error('setup');
      expect(answerOf(await store.beginSend(id, key, a.row.fence, CONTRACT_BEGIN, ADMITTED))).toBe('fenced_out');
      expect(await store.complete(id, key, a.row.fence, { kind: 'accepted', messageId: 'stale' }, 3)).toBe('fenced_out');
      expect(answerOf(await store.beginSend(id, key, b.row.fence, CONTRACT_BEGIN, ADMITTED))).toBe('ok');
      expect(await store.complete(id, key, b.row.fence, { kind: 'accepted', messageId: 'm-b' }, 3)).toBe('ok');
      expect(await store.complete(id, key, b.row.fence, { kind: 'rejected', httpStatus: 422, code: 'x', retryable: false }, 3)).toBe('fenced_out');
      const row = (await store.load(id))!.deliveries.find((d) => d.recipientKey === key)!;
      expect(row).toMatchObject({ status: 'accepted', providerMessageId: 'm-b', fence: 2 });
    });

    it('an accepted delivery is never claimed again', async () => {
      const { store, id, key } = await setup();
      const a = await store.claim(id, key, 'a', CONTRACT_POLICY);
      if (!a.claimed) throw new Error('setup');
      await store.beginSend(id, key, a.row.fence, CONTRACT_BEGIN, ADMITTED);
      await store.complete(id, key, a.row.fence, { kind: 'accepted', messageId: 'm-1' }, 3);
      expect(await store.claim(id, key, 'b', CONTRACT_POLICY)).toEqual({ claimed: false, reason: 'accepted' });
    });

    it('a refusal that parks a row is itself persisted', async () => {
      const { clock, store, id, key } = await setup();
      const a = await store.claim(id, key, 'a', CONTRACT_POLICY);
      if (!a.claimed) throw new Error('setup');
      await store.beginSend(id, key, a.row.fence, CONTRACT_BEGIN, ADMITTED);
      await store.complete(id, key, a.row.fence, { kind: 'unknown', reason: 'timeout' }, 3);
      clock.advance(23 * HOUR); // 24 h retention − 1 h margin, from the first beginSend
      expect(await store.claim(id, key, 'b', CONTRACT_POLICY)).toEqual({ claimed: false, reason: 'needs_reconciliation' });
      const row = (await store.load(id))!.deliveries.find((d) => d.recipientKey === key)!;
      expect(row.status).toBe('needs_reconciliation');
    });

    it('nothing a claim, mark or completion does changes the recipient, key or bytes', async () => {
      const { store, frozen, id, key } = await setup();
      const before = frozen.deliveries.find((d) => d.recipientKey === key)!;
      const a = await store.claim(id, key, 'a', CONTRACT_POLICY);
      if (!a.claimed) throw new Error('setup');
      await store.beginSend(id, key, a.row.fence, CONTRACT_BEGIN, ADMITTED);
      await store.complete(id, key, a.row.fence, { kind: 'accepted', messageId: 'm-1' }, 3);
      const after = (await store.load(id))!.deliveries.find((d) => d.recipientKey === key)!;
      for (const f of ['recipientKey', 'idempotencyKey', 'payload', 'payloadJson', 'payloadHash', 'occurrenceId'] as const) expect(after[f]).toEqual(before[f]);
    });

    it('a lease that lapsed after the mark makes the row ambiguous; one that lapsed before it does not', async () => {
      const { clock, store, id, key } = await setup();
      const other = recipientKeyOf('admin-two@example.test');
      const a = await store.claim(id, key, 'a', CONTRACT_POLICY);
      const b = await store.claim(id, other, 'a', CONTRACT_POLICY);
      if (!a.claimed || !b.claimed) throw new Error('setup');
      expect(answerOf(await store.beginSend(id, key, a.row.fence, CONTRACT_BEGIN, ADMITTED))).toBe('ok'); // marked; `other` is not
      clock.advance(5 * MINUTE);
      const again = await store.claim(id, key, 'c', CONTRACT_POLICY);
      const againOther = await store.claim(id, other, 'c', CONTRACT_POLICY);
      expect(again.claimed && again.row).toMatchObject({ ambiguous: true, fence: 2, attempts: 2, firstSendAt: start });
      expect(againOther.claimed && againOther.row).toMatchObject({ ambiguous: false, fence: 2, attempts: 2, firstSendAt: null });
    });

    it('the retention anchor is the FIRST mark; later marks do not move it', async () => {
      const { clock, store, id, key } = await setup();
      const a = await store.claim(id, key, 'a', CONTRACT_POLICY);
      if (!a.claimed) throw new Error('setup');
      await store.beginSend(id, key, a.row.fence, CONTRACT_BEGIN, ADMITTED);
      await store.complete(id, key, a.row.fence, { kind: 'unknown', reason: 'timeout' }, 3);
      clock.advance(HOUR);
      const b = await store.claim(id, key, 'b', CONTRACT_POLICY);
      if (!b.claimed) throw new Error('setup');
      await store.beginSend(id, key, b.row.fence, CONTRACT_BEGIN, ADMITTED);
      const row = (await store.load(id))!.deliveries.find((d) => d.recipientKey === key)!;
      expect(row.firstSendAt).toBe(start);
    });

    it('a claim at the attempt limit parks the row instead of claiming it', async () => {
      const { clock, store, id, key } = await setup();
      for (let i = 0; i < 3; i += 1) { expect((await store.claim(id, key, `w${i}`, CONTRACT_POLICY)).claimed).toBe(true); clock.advance(5 * MINUTE); }
      expect(await store.claim(id, key, 'w4', CONTRACT_POLICY)).toEqual({ claimed: false, reason: 'exhausted' });
      expect((await store.load(id))!.deliveries.find((d) => d.recipientKey === key)!.status).toBe('exhausted');
    });

    it('beginSend is refused when too little lease is left, and parks an ambiguous row that reached the cut-off', async () => {
      const { clock, store, id, key } = await setup();
      const a = await store.claim(id, key, 'a', CONTRACT_POLICY);
      if (!a.claimed) throw new Error('setup');
      clock.advance(5 * MINUTE - 1_000);
      expect(answerOf(await store.beginSend(id, key, a.row.fence, CONTRACT_BEGIN, ADMITTED))).toBe('lease_expired');
      expect((await store.load(id))!.deliveries.find((d) => d.recipientKey === key)!).toMatchObject({ status: 'in_flight', sendStartedAt: null });
      // An ambiguous row claimed just inside the window, marked just after it:
      clock.advance(1_000);
      const b = await store.claim(id, key, 'b', CONTRACT_POLICY);
      if (!b.claimed) throw new Error('setup');
      expect(answerOf(await store.beginSend(id, key, b.row.fence, CONTRACT_BEGIN, ADMITTED))).toBe('ok');
      await store.complete(id, key, b.row.fence, { kind: 'unknown', reason: 'timeout' }, 3);
      const firstMark = Date.parse((await store.load(id))!.deliveries.find((d) => d.recipientKey === key)!.firstSendAt!);
      clock.set(new Date(firstMark + 23 * HOUR - 1).toISOString());
      const c = await store.claim(id, key, 'c', { ...CONTRACT_POLICY, leaseMs: 2 * HOUR });
      if (!c.claimed) throw new Error('setup');
      clock.advance(1);
      expect(answerOf(await store.beginSend(id, key, c.row.fence, CONTRACT_BEGIN, ADMITTED))).toBe('retention_passed');
      expect((await store.load(id))!.deliveries.find((d) => d.recipientKey === key)!.status).toBe('needs_reconciliation');
    });

    it('ambiguity is sticky: a later retryable refusal leaves the row unknown and ambiguous', async () => {
      const { clock, store, id, key } = await setup();
      const a = await store.claim(id, key, 'a', CONTRACT_POLICY);
      if (!a.claimed) throw new Error('setup');
      await store.beginSend(id, key, a.row.fence, CONTRACT_BEGIN, ADMITTED);
      await store.complete(id, key, a.row.fence, { kind: 'unknown', reason: 'timeout' }, 3);
      clock.advance(MINUTE);
      const b = await store.claim(id, key, 'b', CONTRACT_POLICY);
      if (!b.claimed) throw new Error('setup');
      await store.beginSend(id, key, b.row.fence, CONTRACT_BEGIN, ADMITTED);
      await store.complete(id, key, b.row.fence, { kind: 'rejected', httpStatus: 429, code: 'rate_limit_exceeded', retryable: true }, 3);
      expect((await store.load(id))!.deliveries.find((d) => d.recipientKey === key)!).toMatchObject({ status: 'unknown', ambiguous: true });
    });

    it('a conflict is terminal, and the completion that uses the last attempt parks the row', async () => {
      const { clock, store, id, key } = await setup();
      const other = recipientKeyOf('admin-two@example.test');
      const a = await store.claim(id, key, 'a', CONTRACT_POLICY);
      if (!a.claimed) throw new Error('setup');
      await store.beginSend(id, key, a.row.fence, CONTRACT_BEGIN, ADMITTED);
      await store.complete(id, key, a.row.fence, { kind: 'payload_conflict' }, 3);
      expect(await store.claim(id, key, 'b', CONTRACT_POLICY)).toEqual({ claimed: false, reason: 'conflict' });
      for (let i = 1; i <= 3; i += 1) {
        const c = await store.claim(id, other, `w${i}`, CONTRACT_POLICY);
        if (!c.claimed) throw new Error(`claim ${i}`);
        await store.beginSend(id, other, c.row.fence, CONTRACT_BEGIN, ADMITTED);
        await store.complete(id, other, c.row.fence, { kind: 'unknown', reason: 'network' }, 3);
        clock.advance(MINUTE);
      }
      expect((await store.load(id))!.deliveries.find((d) => d.recipientKey === other)!.status).toBe('needs_reconciliation');
    });

    it('occurrences are independent: the same recipient in another occurrence is untouched', async () => {
      const { clock, store, id, key } = await setup();
      const second = freezePlan(contractPlan({ occurrenceId: 'admin-digest:2026-10-01T12:30:00.000Z' }), clock.now());
      await store.freeze(second.occurrence, second.deliveries);
      const a = await store.claim(id, key, 'a', CONTRACT_POLICY);
      if (!a.claimed) throw new Error('setup');
      await store.beginSend(id, key, a.row.fence, CONTRACT_BEGIN, ADMITTED);
      await store.complete(id, key, a.row.fence, { kind: 'accepted', messageId: 'm-1' }, 3);
      const untouched = (await store.load(second.occurrence.occurrenceId))!.deliveries.find((d) => d.recipientKey === key)!;
      expect(untouched).toMatchObject({ status: 'pending', fence: 0, attempts: 0, providerMessageId: null });
      const b = await store.claim(second.occurrence.occurrenceId, key, 'b', CONTRACT_POLICY);
      expect(b.claimed && b.row.fence).toBe(1);
    });

    it('the completion rule itself refuses an "accepted" without a message id', async () => {
      const { store, id, key } = await setup();
      const a = await store.claim(id, key, 'a', CONTRACT_POLICY);
      if (!a.claimed) throw new Error('setup');
      await store.beginSend(id, key, a.row.fence, CONTRACT_BEGIN, ADMITTED);
      await store.complete(id, key, a.row.fence, { kind: 'accepted', messageId: '' }, 3);
      expect((await store.load(id))!.deliveries.find((d) => d.recipientKey === key)!).toMatchObject({ status: 'unknown', ambiguous: true, providerMessageId: null });
    });

    it('a completion without a mark is refused: a claim that never marked a send owns no provider answer', async () => {
      const { store, id, key } = await setup();
      const a = await store.claim(id, key, 'a', CONTRACT_POLICY);
      if (!a.claimed) throw new Error('setup');
      expect(await store.complete(id, key, a.row.fence, { kind: 'unknown', reason: 'timeout' }, 3)).toBe('fenced_out');
      expect((await store.load(id))!.deliveries.find((d) => d.recipientKey === key)!).toMatchObject({ status: 'in_flight', ambiguous: false, firstSendAt: null });
    });

    it('a granted mark carries its dispatch deadline: lease minus the send deadline, and for an ambiguous row also first mark plus retention minus margin', async () => {
      const { clock, store, id, key } = await setup();
      const a = await store.claim(id, key, 'a', CONTRACT_POLICY);
      if (!a.claimed) throw new Error('setup');
      expect(await store.beginSend(id, key, a.row.fence, CONTRACT_BEGIN, ADMITTED)).toEqual({ ok: true, dispatchBy: new Date(Date.parse(start) + 5 * MINUTE - 1_000).toISOString() });
      await store.complete(id, key, a.row.fence, { kind: 'unknown', reason: 'timeout' }, 3);
      clock.set(new Date(Date.parse(start) + 23 * HOUR - 2 * MINUTE).toISOString()); // retention now binds before the lease
      const b = await store.claim(id, key, 'b', CONTRACT_POLICY);
      if (!b.claimed) throw new Error('setup');
      expect(await store.beginSend(id, key, b.row.fence, CONTRACT_BEGIN, ADMITTED)).toEqual({ ok: true, dispatchBy: new Date(Date.parse(start) + 23 * HOUR).toISOString() });
    });

    it('a row that was only ever refused is not bound by retention: its dispatch deadline is the lease alone, at any age', async () => {
      const { clock, store, id, key } = await setup();
      const a = await store.claim(id, key, 'a', CONTRACT_POLICY);
      if (!a.claimed) throw new Error('setup');
      expect(answerOf(await store.beginSend(id, key, a.row.fence, CONTRACT_BEGIN, ADMITTED))).toBe('ok');
      await store.complete(id, key, a.row.fence, { kind: 'rejected', httpStatus: 429, code: 'rate_limit_exceeded', retryable: true }, 3);
      const later = new Date(Date.parse(start) + 30 * HOUR).toISOString(); // long past first mark + retention − margin
      clock.set(later);
      const b = await store.claim(id, key, 'b', CONTRACT_POLICY);
      if (!b.claimed) throw new Error('setup');
      expect(b.row).toMatchObject({ ambiguous: false, firstSendAt: start });
      expect(await store.beginSend(id, key, b.row.fence, CONTRACT_BEGIN, ADMITTED)).toEqual({ ok: true, dispatchBy: new Date(Date.parse(later) + 5 * MINUTE - 1_000).toISOString() });
    });

    it('an unknown occurrence or recipient is not found, not created', async () => {
      const { store, id } = await setup();
      expect(await store.claim(id, 'f'.repeat(64), 'a', CONTRACT_POLICY)).toEqual({ claimed: false, reason: 'not_found' });
      expect(await store.load('admin-digest:never')).toBeNull();
    });

    describe('eligibility at admission (0474): the allowlist from the caller, super_admins from the store', () => {
      const rowOf = async (store: DigestDeliveryStore, id: string, key: string) => (await store.load(id))!.deliveries.find((d) => d.recipientKey === key)!;

      it('a recipient on neither is withdrawn under the live fence: terminal and durable, with the bytes and key kept', async () => {
        const { store, frozen, id, key } = await setup();
        const before = frozen.deliveries.find((d) => d.recipientKey === key)!;
        const a = await store.claim(id, key, 'a', CONTRACT_POLICY);
        if (!a.claimed) throw new Error('setup');
        expect(answerOf(await store.beginSend(id, key, a.row.fence, CONTRACT_BEGIN, TABLE_ONLY))).toBe('withdrawn');
        const row = await rowOf(store, id, key);
        expect(row).toMatchObject({
          status: 'withdrawn', fence: 1, attempts: 1, leaseOwner: null, leaseExpiresAt: null, sendStartedAt: null,
          firstSendAt: null, ambiguous: false, providerMessageId: null, lastError: 'recipient_no_longer_eligible',
        });
        for (const f of ['recipientKey', 'idempotencyKey', 'payload', 'payloadJson', 'payloadHash'] as const) expect(row[f]).toEqual(before[f]);
        // The withdrawing claim owns no provider answer, and no later claim or admission can use the row.
        expect(await store.complete(id, key, a.row.fence, { kind: 'accepted', messageId: 'm-late' }, 3)).toBe('fenced_out');
        expect(await store.claim(id, key, 'b', CONTRACT_POLICY)).toEqual({ claimed: false, reason: 'withdrawn' });
        expect(answerOf(await store.beginSend(id, key, a.row.fence, CONTRACT_BEGIN, ADMITTED))).toBe('fenced_out');
        expect(await rowOf(store, id, key)).toEqual(row);
      });

      it('withdrawal is final for the occurrence: adding the admin back does not revive the row', async () => {
        const { store, id, key } = await setup();
        const a = await store.claim(id, key, 'a', CONTRACT_POLICY);
        if (!a.claimed) throw new Error('setup');
        expect(answerOf(await store.beginSend(id, key, a.row.fence, CONTRACT_BEGIN, TABLE_ONLY))).toBe('withdrawn');
        await admins().set(['admin-one@example.test']);
        expect(await store.claim(id, key, 'b', CONTRACT_POLICY)).toEqual({ claimed: false, reason: 'withdrawn' });
      });

      it('a super_admins row admits, matched on the address as the engine normalises it (case, ASCII and Unicode whitespace)', async () => {
        const { store, id, key } = await setup();
        const other = recipientKeyOf('admin-two@example.test');
        await admins().set([' Admin-One@Example.TEST\t', '\u00a0\ufeffADMIN-TWO@example.test\u3000']);
        for (const k of [key, other]) {
          const c = await store.claim(id, k, 'a', CONTRACT_POLICY);
          if (!c.claimed) throw new Error('setup');
          expect(answerOf(await store.beginSend(id, k, c.row.fence, CONTRACT_BEGIN, TABLE_ONLY))).toBe('ok');
        }
      });

      it('an address that differs in anything but case and surrounding whitespace does not admit', async () => {
        const { store, id, key } = await setup();
        await admins().set(['admin-one@example.test.', 'admin-one+x@example.test', 'admin-one@example.tes', 'admin one@example.test', 'admin-two@example.test']);
        const a = await store.claim(id, key, 'a', CONTRACT_POLICY);
        if (!a.claimed) throw new Error('setup');
        expect(answerOf(await store.beginSend(id, key, a.row.fence, CONTRACT_BEGIN, TABLE_ONLY))).toBe('withdrawn');
      });

      // Review 5373785714: PostgreSQL's lower() follows the database collation (libc C.UTF-8 and ICU
      // tr-TR turn U+0130 into a plain "i"); JavaScript's toLowerCase() turns it into "i" + U+0307. A
      // table row must never stand in for a different, removed admin, so the match lowercases ASCII
      // only: an address that differs in non-ASCII case does not match (fail closed, withdrawn).
      it('a capital dotted I is not a plain i: another table row cannot admit the removed admin', async () => {
        const { store, id, key } = await setup();
        await admins().set(['adm\u0130n-one@example.test', 'ADM\u0130N-ONE@EXAMPLE.TEST']);
        const a = await store.claim(id, key, 'a', CONTRACT_POLICY);
        if (!a.claimed) throw new Error('setup');
        expect(answerOf(await store.beginSend(id, key, a.row.fence, CONTRACT_BEGIN, TABLE_ONLY))).toBe('withdrawn');
      });

      it('a non-ASCII address matches on its own identity: ASCII case and whitespace are forgiven, non-ASCII case is not', async () => {
        const clock = new FakeClock(start);
        const store = make(clock);
        const frozen = freezePlan(contractPlan({ recipients: ['jos\u00e9@example.test', 'm\u00fcller@example.test', '\u00e5sa@example.test'] }), clock.now());
        await store.freeze(frozen.occurrence, frozen.deliveries);
        const id = frozen.occurrence.occurrenceId;
        await admins().set([
          'jos\u00e9@example.test', // the same identity, as stored
          ' M\u00fcLLER@Example.TEST\u3000', // ASCII case and Unicode whitespace only
          '\u00c5SA@example.test', // differs in non-ASCII case: equivalence is not proved, so no match
        ]);
        const answer = async (address: string) => {
          const k = recipientKeyOf(address);
          const c = await store.claim(id, k, 'a', CONTRACT_POLICY);
          if (!c.claimed) throw new Error('setup');
          return answerOf(await store.beginSend(id, k, c.row.fence, CONTRACT_BEGIN, TABLE_ONLY));
        };
        expect(await answer('jos\u00e9@example.test')).toBe('ok');
        expect(await answer('m\u00fcller@example.test')).toBe('ok');
        expect(await answer('\u00e5sa@example.test')).toBe('withdrawn');
      });

      it('a stale claimant cannot withdraw: it is fenced out, and the live claim decides', async () => {
        const { clock, store, id, key } = await setup();
        const a = await store.claim(id, key, 'a', CONTRACT_POLICY);
        clock.advance(5 * MINUTE);
        const b = await store.claim(id, key, 'b', CONTRACT_POLICY);
        if (!a.claimed || !b.claimed) throw new Error('setup');
        expect(answerOf(await store.beginSend(id, key, a.row.fence, CONTRACT_BEGIN, TABLE_ONLY))).toBe('fenced_out');
        expect(await rowOf(store, id, key)).toMatchObject({ status: 'in_flight', fence: 2, leaseOwner: 'b' });
        expect(answerOf(await store.beginSend(id, key, b.row.fence, CONTRACT_BEGIN, TABLE_ONLY))).toBe('withdrawn');
      });

      it('an earlier send that may have been accepted stays visible: withdrawal keeps ambiguity, the anchor and the attempts', async () => {
        const { clock, store, id, key } = await setup();
        const a = await store.claim(id, key, 'a', CONTRACT_POLICY);
        if (!a.claimed) throw new Error('setup');
        expect(answerOf(await store.beginSend(id, key, a.row.fence, CONTRACT_BEGIN, ADMITTED))).toBe('ok');
        await store.complete(id, key, a.row.fence, { kind: 'unknown', reason: 'timeout' }, 3);
        clock.advance(MINUTE);
        const b = await store.claim(id, key, 'b', CONTRACT_POLICY);
        if (!b.claimed) throw new Error('setup');
        expect(answerOf(await store.beginSend(id, key, b.row.fence, CONTRACT_BEGIN, TABLE_ONLY))).toBe('withdrawn');
        expect(await rowOf(store, id, key)).toMatchObject({ status: 'withdrawn', ambiguous: true, firstSendAt: start, attempts: 2, fence: 2, sendStartedAt: null });
      });

      it('eligibility is decided before the lease and retention checks', async () => {
        const { clock, store, id, key } = await setup();
        const a = await store.claim(id, key, 'a', CONTRACT_POLICY);
        if (!a.claimed) throw new Error('setup');
        clock.advance(5 * MINUTE - 1_000); // too little lease left to send
        expect(answerOf(await store.beginSend(id, key, a.row.fence, CONTRACT_BEGIN, TABLE_ONLY))).toBe('withdrawn');
      });

      it('an unreadable super_admins fails the admission and writes nothing, even for an allowlisted recipient', async () => {
        const { store, id, key } = await setup();
        const a = await store.claim(id, key, 'a', CONTRACT_POLICY);
        if (!a.claimed) throw new Error('setup');
        const before = await rowOf(store, id, key);
        await admins().breakTable();
        await expect(store.beginSend(id, key, a.row.fence, CONTRACT_BEGIN, TABLE_ONLY)).rejects.toThrow();
        await expect(store.beginSend(id, key, a.row.fence, CONTRACT_BEGIN, ADMITTED)).rejects.toThrow();
        // A superseded fence is answered before the table is read.
        expect(answerOf(await store.beginSend(id, key, a.row.fence + 1, CONTRACT_BEGIN, TABLE_ONLY))).toBe('fenced_out');
        expect(await rowOf(store, id, key)).toEqual(before);
      });
    });
  });
}
