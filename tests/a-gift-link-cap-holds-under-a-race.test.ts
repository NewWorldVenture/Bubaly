import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

// A gift link is public: anyone holding it can pledge, and pending pledges are
// capped at 25 per link as the anti-abuse control. The cap used to be a count
// followed by an insert, so submissions racing at 24 all read 24 and all
// inserted. These drive the real `submitGiftPledgeAction` with a barrier that
// holds every racer's pre-check until all of them have read the stale 24 —
// the interleaving a burst of concurrent submissions produces.

const LINK = { id: 'link-1', family_id: 'fam-1', child_wallet_id: 'wallet-1', is_active: true, occasion: 'birthday', token: 'tok-abc' };

let db: ReturnType<typeof createInMemorySupabase>;
let barrier: { waiting: number; release: (() => void) | null; size: number } | null;
let recountFails = false;
const notify = vi.fn(async () => ({ ok: true, data: { created: 1 } }));

/**
 * The service client the action gets: the in-memory database, with the
 * pre-check count held at the barrier and, optionally, the post-insert recount
 * failing.
 */
function client() {
  let headCounts = 0;
  return {
    from(table: string) {
      const builder = db.from(table) as unknown as Record<string, (...a: unknown[]) => unknown>;
      if (table !== 'gift_payments') return builder;
      const select = builder.select.bind(builder);
      builder.select = (cols?: unknown, opts?: unknown) => {
        const q = select(cols, opts) as Record<string, unknown>;
        if (!(opts as { head?: boolean } | undefined)?.head) return q;
        headCounts += 1;
        const nth = headCounts;
        const then = (q.then as (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise<unknown>).bind(q);
        q.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => {
          // Per submission: head count #1 is the pre-check, #2 the recount.
          if (nth === 2 && recountFails) return Promise.resolve({ data: null, count: null, error: { message: 'statement timeout' } }).then(ok, ko);
          if (nth === 1 && barrier) {
            const b = barrier;
            return then(async (v: unknown) => {
              b.waiting += 1;
              if (b.waiting === b.size) b.release?.();
              else await new Promise<void>((r) => { const prev = b.release; b.release = () => { prev?.(); r(); }; });
              return ok(v);
            }, ko);
          }
          return then(ok, ko);
        };
        return q;
      };
      return builder;
    },
  };
}

vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-forwarded-for': '203.0.113.7' }) }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/request-rate-limit', () => ({ enforceRequestRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/services/notifications', () => ({ notify: (...a: unknown[]) => notify(...(a as [])) }));
vi.mock('@/lib/services/scope', () => ({ systemScopeForFamily: async () => ({ familyId: 'fam-1' }) }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => client() }));

function seedPending(n: number) {
  db.seed('gift_payments', Array.from({ length: n }, (_, i) => ({
    id: `old-${i}`, family_id: 'fam-1', gift_link_id: 'link-1', child_wallet_id: 'wallet-1',
    giver_name: `Giver ${i}`, amount_cents: 500, status: 'pending', created_at: `2026-10-0${1 + (i % 3)}T00:00:00Z`,
  })));
}

const pending = () => db.table('gift_payments').filter((r) => r.gift_link_id === 'link-1' && r.status === 'pending');

async function pledge(name: string) {
  const { submitGiftPledgeAction } = await import('@/app/gift/actions');
  return submitGiftPledgeAction({ token: 'tok-abc', giverName: name, amountCents: 1000 });
}

beforeEach(() => {
  db = createInMemorySupabase();
  db.seed('gift_links', [LINK]);
  barrier = null;
  recountFails = false;
  notify.mockClear();
});

describe('a gift link holds its 25-pending cap', () => {
  it('three pledges racing at 24 leave the link at the cap, never past it', async () => {
    seedPending(24);
    barrier = { waiting: 0, release: null, size: 3 };
    const results = await Promise.all([pledge('Ana'), pledge('Ben'), pledge('Cy')]);
    expect(pending().length).toBeLessThanOrEqual(25);
    const accepted = results.filter((r) => r.ok);
    // Every pledge told "yes" is still pending; every refused one left nothing behind.
    expect(pending().length).toBe(24 + accepted.length);
    for (const r of results.filter((x) => !x.ok)) expect(r.error).toBe('actions.tooManyPendingGiftsOn');
    expect(notify).toHaveBeenCalledTimes(accepted.length);
  });

  it('a pledge whose recount cannot be read takes itself back, and nobody is notified', async () => {
    seedPending(10);
    recountFails = true;
    const result = await pledge('Dee');
    expect(result).toEqual({ ok: false, error: 'actions.couldNotRecordYourGift' });
    expect(pending().length).toBe(10);
    expect(notify).not.toHaveBeenCalled();
  });

  it('control: under the cap a pledge stands and the family hears about it', async () => {
    seedPending(10);
    const result = await pledge('Eve');
    expect(result).toEqual({ ok: true });
    expect(pending().length).toBe(11);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('control: at the cap the pre-check refuses without writing', async () => {
    seedPending(25);
    const result = await pledge('Fay');
    expect(result).toEqual({ ok: false, error: 'actions.tooManyPendingGiftsOn' });
    expect(pending().length).toBe(25);
  });
});
