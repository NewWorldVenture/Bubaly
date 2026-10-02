// Actual engine/adapter, synthetic store and provider: no database or network.
import { describe, expect, it, vi } from 'vitest';
import {
  decideCompletion, deliverDigestOccurrence, freezePlan, recipientKeyOf, RESEND_KEY_RETENTION_MS,
  type DeliveryRow, type DigestEmailProvider,
} from '@/lib/admin/digest-delivery';
import { createPostgresDigestDeliveryStore } from '@/lib/admin/digest-delivery-store';
import { FakeClock, HOUR, MINUTE, MemoryDigestDeliveryStore } from './helpers/digest-delivery-fakes';
import { contractPlan } from './helpers/digest-delivery-store-contract';

const NOW = '2026-09-30T12:31:00.000Z';
const TO = 'admin-one@example.test';
const PLAN = contractPlan({ recipients: [TO] });
const KEY = recipientKeyOf(TO);
// 0474 (#710) decides eligibility at each send's admission. These cases are about receipts, so the
// recipient stays on the allowlist and admission never withdraws them.
const STILL_AN_ADMIN = { allowlisted: () => true };
const invalid = [
  ['embedded NUL', 'message\u0000id'],
  ['lone high surrogate', 'message\ud800id'],
  ['lone low surrogate', 'message\udfffid'],
  ['reversed surrogate pair', '\udfff\ud800'],
  ['trailing high surrogate after a valid pair', '\ud83d\ude00\ud800'],
] as const;
const valid = [
  ['UUID', '00000000-0000-4000-8000-000000000001'],
  ['BMP and combining characters', 're\u00e7u-e\u0301-\u4e2d'],
  ['200 supplementary characters', '\ud83d\ude00'.repeat(200)],
  ['surrogate boundary scalars', '\ud7ff\ue000\ud800\udc00\udbff\udfff'],
] as const;

function markedRow(): DeliveryRow {
  return { ...freezePlan(PLAN, new Date(NOW)).deliveries[0], status: 'in_flight', fence: 1,
    attempts: 1, leaseOwner: 'synthetic', leaseExpiresAt: '2026-09-30T12:36:00.000Z',
    sendStartedAt: NOW, firstSendAt: NOW };
}

describe('receipt IDs must survive the PostgreSQL JSON/text boundary unchanged', () => {
  it.each(invalid)('%s stays unknown in the completion rule', (_label, messageId) => {
    expect(decideCompletion(markedRow(), 1, { kind: 'accepted', messageId }, new Date(NOW), 3))
      .toMatchObject({ status: 'unknown', ambiguous: true, providerMessageId: null });
  });

  it.each(invalid)('%s never reaches the adapter RPC', async (_label, messageId) => {
    const rpc = vi.fn(async () => 'ok');
    const store = createPostgresDigestDeliveryStore(rpc);
    await expect(store.complete(PLAN.occurrenceId, KEY, 1, { kind: 'accepted', messageId }, 3)).rejects.toThrow(TypeError);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each(invalid)('%s retains ambiguity and identical retry keys/bytes through exhaustion', async (_label, messageId) => {
    const clock = new FakeClock(NOW);
    const store = new MemoryDigestDeliveryStore(clock.now);
    const complete = vi.spyOn(store, 'complete');
    const requests: Array<{ key: string; bytes: string }> = [];
    const provider: DigestEmailProvider = { send: async ({ idempotencyKey, payloadJson }) => {
      requests.push({ key: idempotencyKey, bytes: payloadJson });
      return { kind: 'accepted', messageId };
    } };
    const deps = { store, provider, owner: 'synthetic', now: clock.now, eligibility: STILL_AN_ADMIN, config: {
      leaseMs: 5 * MINUTE, sendTimeoutMs: 150, maxAttempts: 3,
      providerKeyRetentionMs: RESEND_KEY_RETENTION_MS, retentionSafetyMarginMs: HOUR,
    } };
    for (let n = 1; n <= 3; n += 1) {
      const report = await deliverDigestOccurrence(PLAN, deps);
      expect(report.complete).toBe(false);
      expect(report.attempts).toEqual([{ recipientKey: KEY, fence: n, result: 'unknown', recorded: 'ok' }]);
      expect(complete.mock.calls[n - 1][3]).toEqual({ kind: 'unknown', reason: 'unreadable_response' });
      expect(store.row(PLAN.occurrenceId, KEY)).toMatchObject({
        status: n === 3 ? 'needs_reconciliation' : 'unknown', ambiguous: true, providerMessageId: null, attempts: n,
      });
    }
    await deliverDigestOccurrence(PLAN, deps);
    expect(requests).toHaveLength(3);
    expect(requests.every(request => request.key === requests[0].key && request.bytes === requests[0].bytes)).toBe(true);
  });

  it.each(valid)('%s remains an unmodified accepted receipt and prevents another send', async (_label, messageId) => {
    const clock = new FakeClock(NOW);
    const store = new MemoryDigestDeliveryStore(clock.now);
    const send = vi.fn(async () => ({ kind: 'accepted' as const, messageId }));
    const deps = { store, provider: { send }, owner: 'synthetic', now: clock.now, eligibility: STILL_AN_ADMIN, config: {
      leaseMs: 5 * MINUTE, sendTimeoutMs: 150, maxAttempts: 3,
      providerKeyRetentionMs: RESEND_KEY_RETENTION_MS, retentionSafetyMarginMs: HOUR,
    } };
    expect((await deliverDigestOccurrence(PLAN, deps)).complete).toBe(true);
    expect((await deliverDigestOccurrence(PLAN, deps)).complete).toBe(true);
    expect(store.row(PLAN.occurrenceId, KEY)?.providerMessageId).toBe(messageId);
    expect(send).toHaveBeenCalledOnce();
    const rpc = vi.fn(async () => 'ok');
    await createPostgresDigestDeliveryStore(rpc).complete(PLAN.occurrenceId, KEY, 1, { kind: 'accepted', messageId }, 3);
    expect(rpc).toHaveBeenCalledExactlyOnceWith('admin_digest_complete', {
      p_occurrence_id: PLAN.occurrenceId, p_recipient_key: KEY, p_fence: 1,
      p_result: { kind: 'accepted', messageId }, p_max_attempts: 3,
    });
  });
});
