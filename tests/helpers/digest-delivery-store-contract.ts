// The executable half of the storage contract for lib/admin/digest-delivery.ts.
// Any DigestDeliveryStore must pass it: today the in-memory store; a PostgreSQL
// adapter later, run against the local stack. Passing it with the in-memory
// store proves the rules, not database durability or isolation.
import { describe, expect, it } from 'vitest';
import {
  freezePlan, recipientKeyOf, RESEND_KEY_RETENTION_MS,
  type ClaimPolicy, type DigestDeliveryStore, type OccurrencePlan,
} from '@/lib/admin/digest-delivery';
import { FakeClock, HOUR, MINUTE } from './digest-delivery-fakes';

export const CONTRACT_POLICY: ClaimPolicy = {
  leaseMs: 5 * MINUTE, maxAttempts: 3, providerKeyRetentionMs: RESEND_KEY_RETENTION_MS, retentionSafetyMarginMs: HOUR,
};

export const contractPlan = (over: Partial<OccurrencePlan> = {}): OccurrencePlan => ({
  occurrenceId: 'admin-digest:2026-09-30T12:30:00.000Z',
  window: { start: '2026-09-29T12:30:00.000Z', end: '2026-09-30T12:30:00.000Z' },
  recipients: ['admin-one@example.test', 'admin-two@example.test'],
  payload: { from: 'Bubaly <digest@example.test>', subject: '[Bubaly] Daily digest · synthetic', html: '<p>2 new families.</p>' },
  ...over,
});

export function describeDigestDeliveryStoreContract(label: string, make: (clock: FakeClock) => DigestDeliveryStore) {
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
      expect(await store.beginSend(id, key, a.row.fence)).toBe('fenced_out');
      expect(await store.complete(id, key, a.row.fence, { kind: 'accepted', messageId: 'stale' }, 3)).toBe('fenced_out');
      expect(await store.beginSend(id, key, b.row.fence)).toBe('ok');
      expect(await store.complete(id, key, b.row.fence, { kind: 'accepted', messageId: 'm-b' }, 3)).toBe('ok');
      expect(await store.complete(id, key, b.row.fence, { kind: 'rejected', httpStatus: 422, code: 'x', retryable: false }, 3)).toBe('fenced_out');
      const row = (await store.load(id))!.deliveries.find((d) => d.recipientKey === key)!;
      expect(row).toMatchObject({ status: 'accepted', providerMessageId: 'm-b', fence: 2 });
    });

    it('an accepted delivery is never claimed again', async () => {
      const { store, id, key } = await setup();
      const a = await store.claim(id, key, 'a', CONTRACT_POLICY);
      if (!a.claimed) throw new Error('setup');
      await store.beginSend(id, key, a.row.fence);
      await store.complete(id, key, a.row.fence, { kind: 'accepted', messageId: 'm-1' }, 3);
      expect(await store.claim(id, key, 'b', CONTRACT_POLICY)).toEqual({ claimed: false, reason: 'accepted' });
    });

    it('a refusal that parks a row is itself persisted', async () => {
      const { clock, store, id, key } = await setup();
      const a = await store.claim(id, key, 'a', CONTRACT_POLICY);
      if (!a.claimed) throw new Error('setup');
      await store.beginSend(id, key, a.row.fence);
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
      await store.beginSend(id, key, a.row.fence);
      await store.complete(id, key, a.row.fence, { kind: 'accepted', messageId: 'm-1' }, 3);
      const after = (await store.load(id))!.deliveries.find((d) => d.recipientKey === key)!;
      for (const f of ['recipientKey', 'idempotencyKey', 'payload', 'payloadJson', 'payloadHash', 'occurrenceId'] as const) expect(after[f]).toEqual(before[f]);
    });

    it('an unknown occurrence or recipient is not found, not created', async () => {
      const { store, id } = await setup();
      expect(await store.claim(id, 'f'.repeat(64), 'a', CONTRACT_POLICY)).toEqual({ claimed: false, reason: 'not_found' });
      expect(await store.load('admin-digest:never')).toBeNull();
    });
  });
}
