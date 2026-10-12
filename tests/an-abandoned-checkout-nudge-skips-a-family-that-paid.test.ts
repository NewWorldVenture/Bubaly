import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

/**
 * The abandoned-checkout cron (app/api/cron/checkout-abandoned/route.ts) reads
 * the pending checkout sessions, fires the `checkout_abandoned` automation for
 * each one past the grace window ("Still thinking it over? Your Bubaly plan is
 * waiting"), and then writes `status: 'abandoned'`. Two things went wrong:
 *
 *  - The write was filtered on `session_id` alone. When the Stripe webhook
 *    completed the session between the read and the write, the person who had
 *    just paid was nudged anyway, and their `completed` row was overwritten to
 *    `abandoned`.
 *  - A parent who opened checkout twice and paid through the second session
 *    left the first one pending. An hour later the family was nudged to finish
 *    a checkout it had already paid for.
 *
 * The run now claims each row with a write guarded on `pending` before firing,
 * and a session whose family completed a checkout since it began is marked
 * abandoned without a nudge.
 */

const state = vi.hoisted(() => ({
  db: null as unknown,
  fired: [] as string[],
  /** Runs once after the pending sessions are read: the webhook landing mid-run. */
  afterRead: null as null | (() => void),
  /** Refuse the read of the families' completed checkouts. */
  failCompletedRead: false,
}));

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (k: string) => k }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/marketing/automation-events', () => ({
  fireAutomationEvent: async (_db: unknown, p: { context?: { sessionId?: string } }) => {
    state.fired.push(String(p.context?.sessionId ?? ''));
    return { workflows: 1, emails: 1, failures: 0 };
  },
}));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => {
    const db = state.db as InMemorySupabase;
    return new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'from') return Reflect.get(target, prop, receiver);
        return (table: string) => {
          const builder = target.from(table) as unknown as Record<string, (...args: unknown[]) => unknown>;
          if (table !== 'checkout_sessions') return builder;
          return wrap(builder);
        };
      },
    });
  },
}));

/** Watches the checkout_sessions builder: fires `afterRead` once the pending read resolves, and can refuse the completed read. */
function wrap(builder: Record<string, (...args: unknown[]) => unknown>): unknown {
  let pendingRead = false;
  let completedRead = false;
  const proxy: unknown = new Proxy(builder, {
    get(target, prop) {
      const value = (target as Record<string | symbol, unknown>)[prop];
      if (prop === 'then') {
        return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
          if (completedRead && state.failCompletedRead) {
            return Promise.resolve({ data: null, error: { code: '57014', message: 'Synthetic read failure' } }).then(resolve, reject);
          }
          return (value as (r: unknown, j: unknown) => Promise<unknown>).call(target, (reply: { data: unknown[] | null }) => {
            if (pendingRead && Array.isArray(reply.data) && reply.data.length === 0 && state.afterRead) {
              const hook = state.afterRead;
              state.afterRead = null;
              hook();
            }
            return resolve(reply);
          }, reject);
        };
      }
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (prop === 'eq' && args[0] === 'status' && args[1] === 'pending') pendingRead = true;
        if (prop === 'eq' && args[0] === 'status' && args[1] === 'completed') completedRead = true;
        if (prop === 'update') pendingRead = false;
        const out = value.apply(target, args);
        return out === target ? proxy : out;
      };
    },
  });
  return proxy;
}

const { GET } = await import('@/app/api/cron/checkout-abandoned/route');
const req = () => new Request('https://bubaly.test/api/cron/checkout-abandoned') as never;

const NOW = new Date('2026-09-19T12:00:00.000Z');
const FAMILY = 'fam-1';
const OTHER = 'fam-2';

function pending(sessionId: string, familyId: string, createdAt = '2026-09-19T09:00:00.000Z') {
  return {
    id: `row-${sessionId}`, session_id: sessionId, family_id: familyId, email: `${familyId}@synthetic.invalid`,
    name: 'Synthetic', plan: 'plus', status: 'pending', created_at: createdAt, completed_at: null, abandoned_at: null,
  };
}
function completed(sessionId: string, familyId: string, completedAt: string) {
  return { ...pending(sessionId, familyId, completedAt), status: 'completed', completed_at: completedAt };
}
const row = (sessionId: string) => (state.db as InMemorySupabase).table('checkout_sessions').find((r) => r.session_id === sessionId);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  state.db = createInMemorySupabase();
  state.fired = [];
  state.afterRead = null;
  state.failCompletedRead = false;
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('an abandoned-checkout nudge', () => {
  it('is not sent for a session the webhook completed during the run, and the completed row is kept', async () => {
    (state.db as InMemorySupabase).seed('checkout_sessions', [pending('cs_paid', FAMILY), pending('cs_left', OTHER)]);
    state.afterRead = () => {
      const r = row('cs_paid')!;
      r.status = 'completed';
      r.completed_at = '2026-09-19T12:00:00.000Z';
    };

    const res = await GET(req());

    expect(state.fired, 'nudged someone who had just paid').toEqual(['cs_left']);
    expect(row('cs_paid')!.status, 'a completed checkout was rewritten as abandoned').toBe('completed');
    expect(row('cs_left')!.status).toBe('abandoned');
    expect(res.status).toBe(200);
  });

  it('is not sent to a family that paid through a later checkout session', async () => {
    (state.db as InMemorySupabase).seed('checkout_sessions', [
      pending('cs_first', FAMILY, '2026-09-19T09:00:00.000Z'),
      completed('cs_second', FAMILY, '2026-09-19T09:20:00.000Z'),
      pending('cs_other', OTHER, '2026-09-19T09:00:00.000Z'),
    ]);

    const res = await GET(req());

    expect(state.fired, 'nudged a family that had paid').toEqual(['cs_other']);
    // Settled, so the next run does not consider it again.
    expect(row('cs_first')!.status).toBe('abandoned');
    expect(row('cs_second')!.status).toBe('completed');
    expect(res.status).toBe(200);
  });

  it('is still sent when the family paid before this checkout began (a later plan change it left)', async () => {
    (state.db as InMemorySupabase).seed('checkout_sessions', [
      completed('cs_last_month', FAMILY, '2026-08-19T09:00:00.000Z'),
      pending('cs_upgrade', FAMILY, '2026-09-19T09:00:00.000Z'),
    ]);

    await GET(req());

    expect(state.fired).toEqual(['cs_upgrade']);
    expect(row('cs_upgrade')!.status).toBe('abandoned');
  });

  it('is not sent for a session an overlapping run claimed after this one read it', async () => {
    (state.db as InMemorySupabase).seed('checkout_sessions', [pending('cs_taken', FAMILY), pending('cs_left', OTHER)]);
    state.afterRead = () => {
      const r = row('cs_taken')!;
      r.status = 'abandoned';
      r.abandoned_at = '2026-09-19T12:00:00.000Z';
    };

    const res = await GET(req());

    expect(state.fired, 'nudged a session another run already owned').toEqual(['cs_left']);
    expect(res.status).toBe(200);
  });

  it('is not sent twice by a second run', async () => {
    (state.db as InMemorySupabase).seed('checkout_sessions', [pending('cs_left', FAMILY)]);

    await GET(req());
    await GET(req());

    expect(state.fired).toEqual(['cs_left']);
  });

  it('is held, and nothing is marked, when the completed checkouts cannot be read', async () => {
    (state.db as InMemorySupabase).seed('checkout_sessions', [pending('cs_left', FAMILY)]);
    state.failCompletedRead = true;

    const res = await GET(req());

    expect(state.fired).toEqual([]);
    expect(row('cs_left')!.status).toBe('pending');
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});
