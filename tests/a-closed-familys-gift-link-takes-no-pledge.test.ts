// A closed family's gift link and Pay-ID take no pledge.
//
// /pay/<handle> checked pay_handles.is_active and gift_links.is_active;
// /gift/<token> and submitGiftPledgeAction checked `link.is_active` and
// nothing else. A family that closed its account (families.closed_at) is never
// told about a pledge — cron/notifications, push and the notification emails
// all skip a closed family — so the giver was told "recorded" and the pledge
// sat pending indefinitely. /api/ai/gift already refused the same family; the
// page, the Pay-ID and the action now agree with it: the link reads as no
// longer active, and nothing is recorded. No money moves either way (a pledge
// needs a parent's approval), so the harm was the misleading confirmation.
//
// Drives the real action and both real pages against the in-memory database.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderTranslated } from './helpers/render-translated';

const EN_US = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
const FAMILY = '00000000-0000-4000-8000-00000000a6f1';
const h = vi.hoisted(() => ({
  db: null as unknown,
  notify: vi.fn(),
  RedirectSignal: class RedirectSignal extends Error { constructor(readonly path: string) { super(`redirect ${path}`); } },
}));

vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-forwarded-for': '203.0.113.9', host: 'example.test' }) }));
vi.mock('next/navigation', () => ({ redirect: (path: string) => { throw new h.RedirectSignal(path); } }));
vi.mock('@/lib/server/request-rate-limit', () => ({ enforceRequestRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/services/scope', () => ({ systemScopeForFamily: async () => ({ familyId: FAMILY }) }));
vi.mock('@/lib/services/notifications', () => ({ notify: h.notify }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => EN_US[key] ?? key }));
vi.mock('@/components/wallet/public-gift-form', () => ({ PublicGiftForm: () => 'GIFT-FORM' }));

const { submitGiftPledgeAction } = await import('@/app/gift/actions');
const { default: PublicGiftPage } = await import('@/app/gift/[token]/page');
const { default: PayHandlePage } = await import('@/app/pay/[handle]/page');

let db: InMemorySupabase;
const pledge = () => submitGiftPledgeAction({ token: 'tok', giverName: 'Grandpa', amountCents: 2_500 });
const giftPage = async () => renderTranslated(await PublicGiftPage({ params: Promise.resolve({ token: 'tok' }) }));
const payPage = async () => renderTranslated(await PayHandlePage({ params: Promise.resolve({ handle: 'mia' }) }));

function household(closedAt: string | null) {
  db = createInMemorySupabase();
  db.seed('families', [{ id: FAMILY, name: 'Example House', closed_at: closedAt }]);
  db.seed('family_members', [{ id: 'm-mia', family_id: FAMILY, display_name: 'Mia Example' }]);
  db.seed('child_wallets', [{ id: 'cw-mia', family_id: FAMILY, member_id: 'm-mia' }]);
  db.seed('pay_handles', [{ handle: 'mia', family_id: FAMILY, child_wallet_id: 'cw-mia', is_active: true }]);
  db.seed('gift_links', [{
    id: 'g1', token: 'tok', family_id: FAMILY, child_wallet_id: 'cw-mia', is_active: true,
    occasion: 'birthday', message: null, suggested_cents: [500], created_at: '2026-10-01T00:00:00Z',
  }]);
  h.db = db;
}

beforeEach(() => {
  h.notify.mockReset().mockResolvedValue({ ok: true, data: { created: 1 } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('a family that closed its account', () => {
  beforeEach(() => household('2026-10-05T09:00:00Z'));

  it('the pledge action records nothing, tells the giver the link is not active, and notifies nobody', async () => {
    expect(await pledge()).toEqual({ ok: false, error: EN_US['actions.thisGiftLinkIsNo'] });
    expect(db.table('gift_payments')).toEqual([]);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('the gift page answers as it does for a retired link: no form, and no child or family named', async () => {
    const html = await giftPage();
    expect(html).toContain(EN_US['pay.noActiveGiftLink']);
    expect(html).not.toContain('GIFT-FORM');
    expect(html).not.toContain('Mia Example');
    expect(html).not.toContain('Example House');
  });

  it('the Pay-ID lands on the "no active gift link" shell instead of forwarding to the link', async () => {
    const html = await payPage();
    expect(html).toContain(EN_US['pay.noActiveGiftLink']);
    expect(html).toContain(EN_US['pay.thisPayIdDoesntHaveAn']);
  });
});

describe('an open family (control)', () => {
  beforeEach(() => household(null));

  it('the pledge is recorded and the parents told', async () => {
    expect(await pledge()).toEqual({ ok: true });
    expect(db.table('gift_payments')).toHaveLength(1);
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it('the gift page draws the form with the child and family named', async () => {
    const html = await giftPage();
    expect(html).toContain('GIFT-FORM');
    expect(html).toContain('Mia Example');
    expect(html).toContain('Example House');
  });

  it('the Pay-ID forwards to the link', async () => {
    await expect(payPage()).rejects.toMatchObject({ path: '/gift/tok' });
  });
});

/**
 * The in-memory client with its `families` read refused. withFaults answers a
 * query that is awaited as a builder; the reads here end in `.maybeSingle()`,
 * which resolves on its own, so the refusal is answered there too.
 */
function familiesReadRefused(base: InMemorySupabase): InMemorySupabase {
  const refused = { data: null, error: { code: 'XX000', message: 'down' }, count: null, status: 400, statusText: 'Bad Request' };
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property !== 'from') return Reflect.get(target, property, receiver);
      return (table: string) => {
        if (table !== 'families') return target.from(table);
        const builder: Record<string, unknown> = new Proxy({}, {
          get(_object, key) {
            if (key === 'maybeSingle' || key === 'single') return async () => refused;
            if (key === 'then') return (resolve: (value: unknown) => unknown) => Promise.resolve(refused).then(resolve);
            return () => builder;
          },
        });
        return builder;
      };
    },
  });
}

describe('a family standing that cannot be read', () => {
  beforeEach(() => {
    household(null);
    h.db = familiesReadRefused(db);
  });

  it('is not a closed family: the action refuses with a retryable error and records nothing', async () => {
    const res = await pledge();
    expect(res.ok).toBe(false);
    expect(res.error).not.toBe(EN_US['actions.thisGiftLinkIsNo']);
    expect(db.table('gift_payments')).toEqual([]);
  });

  it('and the gift page draws its retryable shell, not "no longer active"', async () => {
    const html = await giftPage();
    expect(html).toContain('load this gift link right now');
    expect(html).not.toContain(EN_US['pay.noActiveGiftLink']);
    expect(html).not.toContain('GIFT-FORM');
  });
});
