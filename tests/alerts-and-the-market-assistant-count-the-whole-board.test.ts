import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { renderTranslated } from './helpers/render-translated';

/**
 * Alerts and the market assistant count the whole open board (MT-8).
 *
 *  - /marketplace/alerts counted each saved search's "N matches on the board"
 *    within the family's 400 newest listings of EVERY status, so once 400
 *    newer rows existed (closed ones included; the seed utility makes 500) an
 *    older open listing was not a match.
 *  - The rail assistant (askMarketAssistantAction) answered from 600 listings
 *    and 600 offers in no order and in every status, with both read errors
 *    dropped: a large family's "you have N listings up and M open offers" was
 *    a sample, and a failed read was answered as an empty board.
 *
 * Both now read what they count (open listings, open offers), every row of
 * it, paged on id; the assistant says so when it cannot read the board. (The
 * seller cockpit's signal reads are the coverage lane's.)
 */
const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: () => undefined, error: () => undefined }) }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-self' }, memberships: [],
    active: { familyId: 'fam-1', role: 'parent', member: { id: 'm-self', family_id: 'fam-1' }, family: { timezone: 'UTC' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { getMessages, translate } = await import('@/lib/i18n/messages');
  const { localeOrDefault } = await import('@/lib/i18n/locales');
  const messages = getMessages('en-US');
  return {
    getLocaleContext: async () => ({ locale: localeOrDefault('en-US'), source: 'default', messages }),
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(messages, key, params),
  };
});
// The grounded engine answers: no model is configured.
vi.mock('@/lib/ai/provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/provider')>()),
  isAIConfigured: async () => false,
}));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));

const { default: AlertsPage } = await import('@/app/(app)/marketplace/alerts/page');
const { askMarketAssistantAction } = await import('@/app/(app)/marketplace/assistant-actions');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const t = (key: string) => translate(SOURCE_MESSAGES, key);

const pad = (i: number) => String(i).padStart(4, '0');
const at = (i: number) => new Date(Date.UTC(2026, 5, 1) + i * 60_000).toISOString();
let db: InMemorySupabase;

const listing = (over: Row): Row => ({
  family_id: 'fam-1', description: null, kind: 'sell', category: 'other', condition: null, price_cents: 1_000,
  rent_period: null, status: 'completed', member_id: 'm-sib', ...over,
});

beforeEach(() => {
  db = createInMemorySupabase();
  harness.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('/marketplace/alerts', () => {
  it('matches an older open listing behind 450 newer closed ones', async () => {
    db.seed('marketplace_saved_searches', [{
      id: 'ss-1', family_id: 'fam-1', member_id: 'm-self', label: null, query: 'bike', kind: null, category: null,
      max_price_cents: null, last_seen_at: at(5_000), created_at: at(0),
    }]);
    db.seed('marketplace_listings', [
      listing({ id: 'l-bike', title: 'Kids bike', status: 'available', created_at: at(1) }),
      ...Array.from({ length: 450 }, (_, i) => listing({ id: `l-${pad(i)}`, title: `Old bike ${i}`, created_at: at(10 + i) })),
    ]);

    const html = renderTranslated(await AlertsPage());

    expect(html).toContain('1 match on the board');
    expect(html).toContain('Kids bike');
    expect(html).not.toContain(t('alerts.nothingMatchesYetWeLl'));
  });
});

describe('the market assistant', () => {
  it('counts the member\'s listings and open offers past 600 rows of the rest', async () => {
    db.seed('marketplace_listings', [
      ...Array.from({ length: 650 }, (_, i) => listing({ id: `l-${pad(i)}`, title: `Sold thing ${i}` })),
      ...['l-self-a', 'l-self-b', 'l-self-c'].map((id) => listing({ id, title: `Mine ${id}`, status: 'available', member_id: 'm-self' })),
    ]);
    db.seed('marketplace_offers', [
      ...Array.from({ length: 650 }, (_, i) => ({ id: `o-${pad(i)}`, family_id: 'fam-1', listing_id: `l-${pad(i)}`, status: 'accepted', member_id: 'm-kid' })),
      { id: 'o-self-1', family_id: 'fam-1', listing_id: 'l-self-a', status: 'open', member_id: 'm-sib' },
      { id: 'o-self-2', family_id: 'fam-1', listing_id: 'l-self-b', status: 'open', member_id: 'm-kid' },
    ]);

    const answer = await askMarketAssistantAction('How am I doing?');

    expect(answer).toMatchObject({ ok: true, source: 'engine' });
    if (!answer.ok) return;
    expect(answer.reply).toContain('You have 3 listings up and 2 open offers waiting on you');
  });

  it('says it could not read the board, rather than answering from an empty one', async () => {
    db.seed('marketplace_listings', [listing({ id: 'l-self-a', title: 'Mine', status: 'available', member_id: 'm-self' })]);
    const realFrom = db.from.bind(db);
    (db as unknown as { from: (table: string) => object }).from = (table: string) => {
      const builder = realFrom(table);
      if (table !== 'marketplace_offers') return builder;
      (builder as { then: typeof builder.then }).then = ((ok, bad) => Promise.resolve({
        data: null, error: { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null }, count: null, status: 500, statusText: 'Error',
      }).then(ok, bad)) as typeof builder.then;
      return builder;
    };

    expect(await askMarketAssistantAction('How am I doing?')).toEqual({ ok: false, error: t('assistantActions.couldNotReadTheBoard') });
  });
});
