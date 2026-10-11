// A checkout that is paid while the abandoned-checkout sweep is running is not
// nudged as abandoned, and is not recorded as abandoned.
//
// The sweep read every `pending` session, then for each one fired the
// `checkout_abandoned` automation ("you left something behind…") and only
// afterwards wrote `status: 'abandoned'` — keyed on the session id alone. A
// buyer who came back after the hour's grace and paid in the window between
// the read and their row's turn had the Stripe webhook upsert their session to
// `completed`; the sweep, still holding the stale `pending`, emailed them a
// cart-recovery nudge for the plan they had just bought and then overwrote
// `completed` with `abandoned`. The longer the batch (each nudge is a provider
// call), the wider that window.
//
// The mark is now the CLAIM: `status = 'pending'` is in the write, it runs
// before the nudge, and only a session this run moved from pending is nudged.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof createInMemorySupabase>,
  fired: [] as string[],
  /** Runs after the sweep's read returns — the webhook landing mid-sweep. */
  afterRead: (() => {}) as () => void,
}));

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (k: string) => k }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/marketing/automation-events', () => ({
  fireAutomationEvent: async (_db: unknown, p: { context?: { sessionId?: string } }) => {
    state.fired.push(String(p.context?.sessionId ?? ''));
    return { workflows: 1, emails: 1, failures: 0 };
  },
}));
vi.mock('@/lib/supabase/read-all', () => ({
  readAll: async () => {
    const rows = state.db.table('checkout_sessions').filter((r) => r.status === 'pending').map((r) => ({ ...r }));
    state.afterRead();
    return { rows, error: null };
  },
}));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => state.db }));

const { GET } = await import('@/app/api/cron/checkout-abandoned/route');
const req = () => new Request('https://bubaly.test/api/cron/checkout-abandoned') as never;

const FROZEN_NOW = new Date('2026-09-19T12:00:00.000Z');
/** Pending three hours: past the 60-minute grace, inside the 24-hour look-back. */
const session = (id: string): Row => ({
  session_id: id, email: `${id}@example.com`, name: 'Sam',
  status: 'pending', created_at: '2026-09-19T09:00:00.000Z', completed_at: null, abandoned_at: null,
});
const row = (id: string) => state.db.table('checkout_sessions').find((r) => r.session_id === id)!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FROZEN_NOW);
  state.db = createInMemorySupabase();
  state.db.seed('checkout_sessions', [session('cs_1'), session('cs_2')]);
  state.fired = [];
  state.afterRead = () => {};
});

describe('a checkout paid mid-sweep is not called abandoned', () => {
  it('the buyer who paid after the read is not nudged, and stays completed', async () => {
    state.afterRead = () => {
      // The Stripe webhook's upsert for cs_2, landing after the sweep's read.
      Object.assign(row('cs_2'), { status: 'completed', completed_at: '2026-09-19T11:59:59.000Z' });
    };

    const res = await GET(req());

    expect(state.fired, 'a buyer who had just paid was sent a cart-recovery nudge').toEqual(['cs_1']);
    expect(row('cs_2'), 'a paid checkout was recorded as abandoned').toMatchObject({ status: 'completed', abandoned_at: null });
    expect(row('cs_1')).toMatchObject({ status: 'abandoned' });
    // Losing a row to its own completion is not a failure of the run.
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, fired: 1, failed: 0 });
  });

  it('every session still pending is nudged once and marked', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(state.fired).toEqual(['cs_1', 'cs_2']);
    expect(state.db.table('checkout_sessions').map((r) => r.status)).toEqual(['abandoned', 'abandoned']);
  });
});
