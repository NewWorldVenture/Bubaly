// A sealed stand-in for the Stripe Issuing SDK surface the money actions call
// (accounts.retrieve, issuing.cardholders.create, issuing.cards.create/update).
// Shared by tests/money-card-retry-characterization.test.ts and
// tests/money-card-attempt-identity.test.ts so both judge card orders against
// one model of the provider. No network: every answer is computed in-process.
import { vi } from 'vitest';
import type Stripe from 'stripe';

type Held = { release: () => void };
type ProviderCard = { id: string; status: 'active' | 'inactive' | 'canceled'; type: string; cardholder: string; limits: unknown[] };
/** What the provider did with one cards.create request, decided when it arrived. */
export type CardOutcome = 'created' | 'replayed' | 'in_use' | 'mismatch' | 'failed' | 'replayed_failure';
type CardBody = { type: string; cardholder: string; status: 'active'; spending_controls?: { spending_limits: unknown[] } };
type RequestOptions = { stripeAccount: string; idempotencyKey: string };

/**
 * A provider double with Stripe's documented idempotency rules, per connected
 * account: a key seen before returns the first result and creates nothing; the
 * same key with different parameters is refused; a new key creates a new
 * object. An update applies when the provider receives it; its RESPONSE can be
 * held, which is how a test orders two in-flight requests.
 *
 * Card creation models every answer Stripe gives a reused key:
 * - a key whose first request has COMPLETED replays its saved result, and
 *   creates nothing (`holdCards('response')` holds the first response after
 *   the provider saved it, so a second request arrives in between);
 * - the same key with different parameters is refused (idempotency_error);
 * - a key whose first request is still EXECUTING is refused with 409
 *   idempotency_key_in_use, and nothing is saved for that request
 *   (`holdCards('execution')` keeps the first one executing). The real SDK
 *   retries a 409 with backoff (maxNetworkRetries, 2 by default); this double
 *   replaces the SDK, so `retryConflicts()` models a retry that comes back
 *   after the first request finished and gets its replay;
 * - a SAVED failure: `failNextCardCreate()` makes the next new key fail after
 *   execution began, and Stripe replays that failure to the same key.
 */
export function syntheticProvider() {
  const replay = new Map<string, { body: string; result: unknown; failure?: Error }>();
  // Keys whose first request is still executing, settled when it finishes.
  const executing = new Map<string, Promise<void>>();
  const cardholders: string[] = [];
  const cards = new Map<string, ProviderCard>();
  const log = {
    cardholderKeys: [] as string[], cardKeys: [] as string[], cardOutcomes: [] as CardOutcome[],
    updates: [] as { id: string; status: unknown }[],
  };
  const held: Held[] = [];
  const heldCards: Held[] = [];
  const forcedCardIds: string[] = [];
  let holdUpdates = false;
  let cardHold: 'execution' | 'response' | null = null;
  let savedFailure: Error | null = null;
  let conflictRetries = false;
  let barrier: { size: number; arrived: number; open: () => void; opened: Promise<void> } | null = null;
  let next = 0;

  function idempotent<T>(account: string, key: string, body: unknown, make: () => T): T {
    const scoped = `${account}:${key}`;
    const json = JSON.stringify(body);
    const prior = replay.get(scoped);
    if (prior) {
      if (prior.body !== json) throw new Error('synthetic idempotency_error: key reused with different parameters');
      return prior.result as T;
    }
    const result = make();
    replay.set(scoped, { body: json, result });
    return result;
  }
  const hold = (into: Held[]) => new Promise<void>(resolve => { into.push({ release: resolve }); });

  const stripe = {
    accounts: { retrieve: vi.fn(async () => ({ individual: { address: { line1: '1 Fixture Lane', city: 'Fixture', state: 'CA', postal_code: '00000', country: 'US' } } })) },
    issuing: {
      cardholders: {
        create: vi.fn(async (body: unknown, opts: RequestOptions) => {
          log.cardholderKeys.push(opts.idempotencyKey);
          const result = idempotent(opts.stripeAccount, opts.idempotencyKey, body, () => {
            const id = `ich_synthetic_${++next}`;
            cardholders.push(id);
            return { id };
          });
          if (barrier) {
            barrier.arrived += 1;
            if (barrier.arrived >= barrier.size) barrier.open();
            await barrier.opened;
          }
          return result;
        }),
      },
      cards: {
        create: vi.fn(async (body: CardBody, opts: RequestOptions) => {
          log.cardKeys.push(opts.idempotencyKey);
          const scoped = `${opts.stripeAccount}:${opts.idempotencyKey}`;
          const json = JSON.stringify(body);
          // A key whose first request is still executing: refused, and the
          // refusal is not saved, so a later request with the key is judged anew.
          for (let running = executing.get(scoped); running; running = executing.get(scoped)) {
            log.cardOutcomes.push('in_use');
            if (!conflictRetries) {
              throw Object.assign(
                new Error('synthetic idempotency_key_in_use: another request with this key is still in progress'),
                { statusCode: 409, code: 'idempotency_key_in_use' },
              );
            }
            await running;
          }
          const prior = replay.get(scoped);
          let result: unknown;
          if (prior) {
            if (prior.body !== json) {
              log.cardOutcomes.push('mismatch');
              throw new Error('synthetic idempotency_error: key reused with different parameters');
            }
            if (prior.failure) {
              log.cardOutcomes.push('replayed_failure');
              throw prior.failure;
            }
            log.cardOutcomes.push('replayed');
            result = prior.result;
          } else {
            if (savedFailure) {
              const failure = savedFailure;
              savedFailure = null;
              log.cardOutcomes.push('failed');
              replay.set(scoped, { body: json, result: null, failure });
              throw failure;
            }
            log.cardOutcomes.push('created');
            let finished = () => {};
            if (cardHold === 'execution') {
              executing.set(scoped, new Promise<void>(resolve => { finished = resolve; }));
              await hold(heldCards);
            }
            const id = forcedCardIds.shift() ?? `ic_synthetic_${++next}`;
            cards.set(id, { id, status: body.status, type: body.type, cardholder: body.cardholder, limits: body.spending_controls?.spending_limits ?? [] });
            result = { id, last4: '0000', brand: 'Visa', exp_month: 1, exp_year: 2030 };
            replay.set(scoped, { body: json, result });
            executing.delete(scoped);
            finished();
          }
          if (cardHold === 'response') await hold(heldCards);
          return result as { id: string; last4: string; brand: string; exp_month: number; exp_year: number };
        }),
        update: vi.fn(async (id: string, body: { status?: ProviderCard['status'] }) => {
          const card = cards.get(id);
          if (!card) throw new Error('synthetic resource_missing');
          if (body.status) card.status = body.status;
          log.updates.push({ id, status: body.status });
          // The response describes the card as this request left it.
          const response = { id, status: card.status };
          if (holdUpdates) await hold(held);
          return response;
        }),
      },
    },
  };

  return {
    stripe, cardholders, cards, log, held, heldCards,
    holdUpdates() { holdUpdates = true; },
    /** Hold every card create from now on, at the stage named (see above). */
    holdCards(stage: 'execution' | 'response') { cardHold = stage; },
    /** A 409 idempotency_key_in_use is retried once the first request finished, as the SDK's backoff would. */
    retryConflicts() { conflictRetries = true; },
    /** The next card the provider creates gets this id instead of a fresh one. */
    nextCardId(id: string) { forcedCardIds.push(id); },
    /** The next card create under a new key fails after it began executing; the failure is saved under that key. */
    failNextCardCreate(failure: Error) { savedFailure = failure; },
    /** The provider prunes saved keys (Stripe keeps them for at least 24 hours). */
    forgetKeys() { replay.clear(); },
    /**
     * Hold every cardholder create until `size` of them have reached the
     * provider. It opens on its own after a second, so a change that stops the
     * second request from arriving fails the assertions instead of hanging.
     */
    cardholderBarrier(size: number) {
      let open!: () => void;
      const opened = new Promise<void>(resolve => { open = resolve; setTimeout(resolve, 1000); });
      barrier = { size, arrived: 0, open, opened };
    },
    seedCard(id: string, status: ProviderCard['status']) { cards.set(id, { id, status, type: 'virtual', cardholder: 'ich_seeded', limits: [] }); },
    /** The event body issuing_card.updated would carry for this card. */
    event(id: string): Stripe.Issuing.Card {
      const card = cards.get(id)!;
      return { id, status: card.status, spending_controls: { spending_limits: card.limits, blocked_categories: [] } } as unknown as Stripe.Issuing.Card;
    },
    active(type?: string) { return [...cards.values()].filter(card => card.status === 'active' && (!type || card.type === type)); },
  };
}
