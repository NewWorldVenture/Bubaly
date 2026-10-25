import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderServerPage } from './helpers/render-server-page';

// /admin/stripe counted onboarded families, active cards and webhook errors by
// reading each table's `status` column with no bound and filtering in memory.
// PostgREST answers at most 1,000 rows per read, so once a table passed a
// thousand rows the figure froze: stripe_webhook_events grows with every Stripe
// event, so "Webhook errors" stopped counting after the first thousand events
// were stored and an error burst was invisible on the console. The sibling
// Financial accounts tile was already a `head: true` count, which is uncapped.
const CAP = 1000;
const ROWS = 1300;
const pad = (i: number) => String(i).padStart(6, '0');

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => h.db,
  describeConfiguredServiceKey: () => null,
}));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
  getLocaleContext: async () => ({ locale: { code: 'en-US' } }),
}));
// The setup form reaches for the app router, which a static render has not.
vi.mock('@/components/admin/stripe-setup-form', () => ({ StripeSetupForm: () => null }));

let db: InMemorySupabase;

function seedPlatform() {
  // In every table the rows that matter — the active cards, the errored events —
  // are the LAST 300, past a read of the first thousand.
  db.seed('feature_flags', []);
  db.seed('stripe_settings', []);
  db.seed('stripe_financial_accounts', []);
  db.seed('stripe_authorizations', []);
  db.seed('stripe_connected_accounts', Array.from({ length: ROWS }, (_, i) => ({
    id: `acct-${pad(i)}`, family_id: `fam-${pad(i)}`, stripe_account_id: `acct_${i}`, status: 'enabled',
  })));
  db.seed('stripe_issuing_cards', Array.from({ length: ROWS }, (_, i) => ({
    id: `card-${pad(i)}`, family_id: `fam-${pad(i)}`, stripe_card_id: `ic_${i}`, status: i < CAP ? 'inactive' : 'active',
  })));
  db.seed('stripe_webhook_events', Array.from({ length: ROWS }, (_, i) => ({
    id: `evt-${pad(i)}`, stripe_event_id: `evt_${i}`, type: 'issuing_authorization.request',
    status: i < CAP ? 'processed' : 'error', created_at: new Date(Date.UTC(2026, 9, 1) + i * 1_000).toISOString(),
  })));
}

/** The value a Stat renders under `label`. */
function stat(html: string, label: string): string {
  const match = new RegExp(`<span class="text-xs">${label}</span></div><p class="mt-1 text-2xl font-bold">([^<]*)</p>`).exec(html);
  if (!match) throw new Error(`the "${label}" stat is not on the page`);
  return match[1];
}

async function render(): Promise<string> {
  const { default: AdminStripeMoneyPage } = await import('@/app/(app)/admin/stripe/page');
  return renderServerPage(await AdminStripeMoneyPage());
}

beforeEach(() => {
  db = createInMemorySupabase({ maxRows: CAP });
  h.db = db;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('/admin/stripe counts every row, not the first thousand', () => {
  it('the control: the fake caps an unbounded read at 1,000 and says nothing', async () => {
    seedPlatform();
    const { data, error } = await db.from('stripe_webhook_events').select('status');
    expect(error).toBeNull();
    expect(data).toHaveLength(CAP);
  });

  it('webhook errors past the first thousand events are counted', async () => {
    seedPlatform();
    const html = await render();
    expect(stat(html, SOURCE_MESSAGES['adminStripe.webhookErrors'])).toBe('300');
  });

  it('active cards past the first thousand are counted', async () => {
    seedPlatform();
    const html = await render();
    expect(stat(html, SOURCE_MESSAGES['adminStripe.activeCards'])).toBe('300');
  });

  it('onboarded families are counted over every connected account', async () => {
    seedPlatform();
    const html = await render();
    expect(stat(html, SOURCE_MESSAGES['adminStripe.onboardedFamilies'])).toBe(`${ROWS}/${ROWS}`);
  });
});
