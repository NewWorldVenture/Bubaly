// An abandoned-checkout sweep that did not do its work must say so.
//
// The route counted `fired` and nothing else. A workflow that threw was logged
// and skipped, and the `status: 'abandoned'` write — the thing that stops the
// row being swept again — had its result discarded entirely. Both paths ended
// at a hardcoded 200, and scripts/cron-dispatch.mjs records nothing but the
// status, so a sweep that reached nobody was indistinguishable from a clean one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  sessions: [] as Row[],
  fired: [] as string[],
  /** Session ids whose automation throws, the way the marketing engine does. */
  fireThrows: new Set<string>(),
  /** Session ids whose `status: 'abandoned'` write is refused. */
  markFails: new Set<string>(),
  marked: [] as string[],
}));

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (k: string) => k }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/marketing/automation-events', () => ({
  fireAutomationEvent: async (_db: unknown, p: { context?: { sessionId?: string } }) => {
    const id = String(p.context?.sessionId ?? '');
    if (state.fireThrows.has(id)) throw new Error('Could not record the automation result.');
    state.fired.push(id);
    return { workflows: 1, emails: 1, failures: 0 };
  },
}));
vi.mock('@/lib/supabase/read-all', () => ({
  readAll: async () => ({ rows: state.sessions, error: null }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: () => {
      const b: Row = {};
      Object.assign(b, {
        select: () => b, eq: (_c: string, v: unknown) => {
          state.marked.push(String(v));
          return state.markFails.has(String(v))
            ? Promise.resolve({ error: { message: 'could not write checkout_sessions' } })
            : Promise.resolve({ error: null });
        },
        update: () => b,
        order: () => b, range: () => b, limit: () => b,
        then: (resolve: (v: unknown) => void) => resolve({ data: state.sessions, error: null }),
      });
      return b;
    },
  }),
}));

const { GET } = await import('@/app/api/cron/checkout-abandoned/route');
const req = () => new Request('https://bubaly.test/api/cron/checkout-abandoned') as never;

const FROZEN_NOW = new Date('2026-09-19T12:00:00.000Z');
/** Pending three hours: past the 60-minute grace, inside the 24-hour look-back. */
const session = (id: string): Row => ({
  session_id: id, email: `${id}@example.com`, name: 'Sam',
  status: 'pending', created_at: '2026-09-19T09:00:00.000Z',
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FROZEN_NOW);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  state.sessions = [session('cs_1'), session('cs_2')];
  state.fired = [];
  state.marked = [];
  state.fireThrows = new Set();
  state.markFails = new Set();
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('the abandoned-checkout sweep reports its own failures', () => {
  it('answers 200 when every nudge went out and every row settled', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, abandoned: 2, fired: 2, failed: 0 });
    expect(state.fired).toEqual(['cs_1', 'cs_2']);
  });

  it('counts a workflow that threw, and does not report the run clean', async () => {
    state.fireThrows.add('cs_2');
    const res = await GET(req());
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, fired: 1, failed: 1 });
    expect(res.status, 'a checkout nobody was nudged about was recorded as a clean run').toBe(502);
    // The other session still gets its nudge: one bad workflow is not the batch.
    expect(state.fired).toEqual(['cs_1']);
  });

  it('counts a refused status write, which otherwise re-sweeps the row unseen', async () => {
    state.markFails.add('cs_1');
    const res = await GET(req());
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, failed: 1 });
    expect(res.status, 'a session left pending forever was recorded as a clean run').toBe(502);
    // Still marks the second: the failure is that row's, not the sweep's.
    expect(state.marked).toEqual(['cs_1', 'cs_2']);
  });
});
