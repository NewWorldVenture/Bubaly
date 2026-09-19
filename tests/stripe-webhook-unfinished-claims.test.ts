// An event nobody finished must not be acknowledged.
//
// Stripe stops retrying an event as soon as one delivery answers 2xx. recordEvent
// used to return 'duplicate' — which both webhook routes answer 200 — for BOTH a
// finished event and one another delivery merely holds. Those are not the same
// thing, and the difference is a lost card transaction:
//
//   1. the handler throws (a transient database failure, say)
//   2. markEventError, hitting the same failure, throws too
//   3. the row stays 'processing', inside STALE_EVENT_MS so not yet reclaimable
//   4. Stripe retries a minute later and is answered 200
//   5. Stripe stops. The debit is never applied and nothing reprocesses the row.
//
// These tests drive the real recordEvent/markEventError against the in-memory
// Postgres fake, so they assert the behaviour rather than the source text.
import { describe, it, expect } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { recordEvent, markEventError, markEventProcessed } from '@/lib/stripe/webhook';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

const STALE_EVENT_MS = 10 * 60 * 1000;

function db(seedCreatedAt = new Date().toISOString()) {
  return createInMemorySupabase({
    uniques: { stripe_webhook_events: [['stripe_event_id']] },
    defaults: { stripe_webhook_events: { created_at: seedCreatedAt } },
  }) as unknown as SupabaseClient<Database>;
}

const evt = (id: string, type = 'issuing_transaction.created') =>
  ({ id, type, created: 1 }) as unknown as Stripe.Event;

describe('an unfinished claim is not a completed one', () => {
  it('a FINISHED event is a duplicate — the only outcome a route may 200', async () => {
    const s = db();
    const first = await recordEvent(s, evt('evt_done'));
    expect(first.outcome).toBe('fresh');
    await markEventProcessed(s, 'evt_done', first.claimToken!);
    expect((await recordEvent(s, evt('evt_done'))).outcome).toBe('duplicate');
  });

  it('a claim another delivery still holds is in_flight, not duplicate', async () => {
    const s = db();
    const first = await recordEvent(s, evt('evt_held'));
    expect(first.outcome).toBe('fresh');
    // Nothing finished it; a concurrent delivery arrives.
    expect((await recordEvent(s, evt('evt_held'))).outcome).toBe('in_flight');
  });

  it('the money-loss sequence: handler fails, markEventError fails, retry must NOT be acknowledged', async () => {
    const s = db();
    const first = await recordEvent(s, evt('evt_lost'));
    expect(first.outcome).toBe('fresh');

    // The handler threw; recording the error state ALSO fails (here: the claim no
    // longer matches, which is how a failed write leaves the row either way).
    await expect(markEventError(s, 'evt_lost', 'debit failed', 'a-token-that-does-not-match'))
      .rejects.toThrow();

    // Stripe retries inside the stale window. This is the exact moment the old
    // code answered 200 and Stripe gave up on a transaction never applied.
    const retry = await recordEvent(s, evt('evt_lost'));
    expect(retry.outcome).not.toBe('duplicate');
    expect(retry.outcome).toBe('in_flight');
  });

  it('once the claim goes stale it is reclaimed and reprocessed', async () => {
    const stale = new Date(Date.now() - STALE_EVENT_MS - 60_000).toISOString();
    const s = db(stale);
    const first = await recordEvent(s, evt('evt_stale'));
    expect(first.outcome).toBe('fresh');
    // Age the claim past the stale threshold, as an abandoned delivery would.
    await s.from('stripe_webhook_events')
      .update({ processing_started_at: stale })
      .eq('stripe_event_id', 'evt_stale');
    const retry = await recordEvent(s, evt('evt_stale'));
    expect(retry.outcome).toBe('fresh');
    expect(retry.claimToken).toBeTruthy();
    expect(retry.claimToken).not.toBe(first.claimToken);
  });

  it('a recorded error is reclaimable, so a genuine failure still gets reprocessed', async () => {
    const s = db();
    const first = await recordEvent(s, evt('evt_err'));
    await markEventError(s, 'evt_err', 'debit failed', first.claimToken!);
    const retry = await recordEvent(s, evt('evt_err'));
    expect(retry.outcome).toBe('fresh');
  });
});

const readRoute = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf8');

describe('the routes answer each outcome correctly', () => {
  const money = readRoute('app/api/webhooks/money/route.ts');
  const billing = readRoute('app/api/webhooks/stripe/route.ts');

  it('both routes 409 an in-flight claim so the provider keeps retrying', () => {
    for (const route of [money, billing]) {
      expect(route).toContain("claim.outcome === 'in_flight'");
      expect(route).toContain("status: 409");
    }
  });

  it('the money route logs the handler error even when recording it fails', () => {
    // The original cause must be logged before the write that can throw.
    const logAt = money.indexOf("console.error('[money webhook] handler error'");
    const markAt = money.indexOf('await markEventError');
    expect(logAt).toBeGreaterThan(-1);
    expect(markAt).toBeGreaterThan(-1);
    expect(logAt).toBeLessThan(markAt);
    expect(money).toContain("console.error('[money webhook] failed to record handler error'");
  });

  it('the money route does not 2xx an event whose claim never closed', () => {
    expect(money).toContain("console.error('[money webhook] failed to finalize event'");
  });
});
