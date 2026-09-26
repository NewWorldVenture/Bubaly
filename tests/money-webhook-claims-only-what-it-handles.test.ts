import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at, between } from './helpers/source-order';

/**
 * Audit C1-S4-01.
 *
 * `/api/webhooks/money` and `/api/webhooks/stripe` are deliberately separate
 * routes with separate signing secrets, and they share ONE idempotency ledger
 * whose uniqueness is `stripe_event_id` alone — no column records which
 * endpoint claimed an event.
 *
 * The money route's `default` branch marked any unrecognised type `processed`.
 * That did not ignore a billing event, it CLAIMED it: the billing endpoint then
 * saw `duplicate` and returned 200 having done no work. Both endpoints answer
 * 2xx, Stripe never retries, nothing logs, and the subscription event is gone.
 *
 * Reachable only under the documented fallback (`STRIPE_MONEY_WEBHOOK_SECRET`
 * unset, so a billing-signed event verifies here), which is a
 * misconfiguration — the finding is the system's silent, permanent response to
 * it, not the misconfiguration itself.
 */
const money = readFileSync('app/api/webhooks/money/route.ts', 'utf8');
const source = money.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const billing = readFileSync('app/api/webhooks/stripe/route.ts', 'utf8');

describe('the money webhook does not consume events it cannot process', () => {
  it('decides what it handles before it claims anything in the shared ledger', () => {
    expect(at(source, 'HANDLED_EVENT_TYPES.has(event.type)')).toBeLessThan(at(source, 'recordEvent(supabase, event)'));
  });

  it('acknowledges an unhandled type without marking it processed', () => {
    const gate = between(source, '!HANDLED_EVENT_TYPES.has(event.type)', 'recordEvent(supabase, event)');
    expect(gate).toContain('received: true, handled: false');
    expect(gate).not.toContain('markEventProcessed');
    expect(gate).not.toContain('recordEvent');
  });

  it('every billing event type lands outside the money route handled set', () => {
    // This is what made the claim asymmetric rather than mutual: the two
    // handled sets are disjoint, so every billing type hit money's default.
    const handled = source.slice(source.indexOf('HANDLED_EVENT_TYPES = new Set'), source.indexOf(']);'));
    for (const type of [
      'checkout.session.completed',
      'customer.subscription.created',
      'customer.subscription.updated',
      'customer.subscription.deleted',
    ]) {
      expect(handled, type).not.toContain(type);
      expect(billing, type).toContain(type);
    }
  });

  it('every type it does claim has a handler', () => {
    const handled = source.slice(source.indexOf('HANDLED_EVENT_TYPES = new Set'), source.indexOf(']);'));
    const types = [...handled.matchAll(/'([a-z_]+\.[a-z_.]+)'/g)].map((m) => m[1]);
    expect(types.length).toBeGreaterThan(4);
    for (const type of types) {
      // Either a switch case, or handled ahead of the dedup (the
      // time-critical authorization request).
      expect(source, type).toMatch(new RegExp(`case '${type.replace('.', '\\.')}'|event\\.type === '${type.replace('.', '\\.')}'`));
    }
  });
});
