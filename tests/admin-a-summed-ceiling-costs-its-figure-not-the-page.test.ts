import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { createElement } from 'react';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { formatCents } from '@/lib/wallet/ledger';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderServerPage, statCardValue, textOf } from './helpers/render-server-page';
import { at, between } from './helpers/source-order';

// The admin reads whose ceilings pre-date this sweep, brought into the same
// classes as the rest of the console (coverage round 6): a SUMMED read that
// reaches its ceiling costs the figures summed from it, which say they are not
// shown and are named in the figures-not-shown banner, and any other failure
// is still the page's read-error state; an OPTIONS read offers the first
// choices and says it is cut short. Before, each of these pages was its
// read-error state at the ceiling — losing the table counts on /admin/backup,
// the partner list and its form on /admin/marketing/affiliates, every
// experiment's controls and the new-experiment form on
// /admin/marketing/experiments, and the visitor counts on
// /admin/marketing/intelligence — or, on /admin/wallet, showed $0.00 beside
// the failure banner; the loyalty award form offered an arbitrary thousand
// families and said nothing. Each case drives the real page against a fake
// that caps a response at 1,000 rows, as PostgREST does.
const CAP = 1000;
const pad = (i: number) => String(i).padStart(6, '0');
const UNAVAILABLE = SOURCE_MESSAGES['strategyMetrics.unavailable'];

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => h.db,
  describeConfiguredServiceKey: () => null,
}));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES: messages } = await import('@/lib/i18n/messages');
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(messages, key, params),
    getLocaleContext: async () => ({ locale: { code: 'en-US' }, messages }),
  };
});
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: ComponentProps<'a'>) => createElement('a', { href, ...props }, children),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: () => {}, success: () => {}, error: () => {} }) }));
// The server actions behind the forms and controls; none carries a number read here.
vi.mock('@/app/(app)/admin/actions', () => ({ adminToggleFeatureFlagAction: async () => ({ ok: true }) }));
vi.mock('@/app/(app)/admin/marketing/affiliates/actions', () => ({
  saveAffiliateAction: async () => {}, toggleAffiliateStatusAction: async () => {},
  deleteAffiliateAction: async () => {}, markAffiliatePaidAction: async () => {},
}));
vi.mock('@/app/(app)/admin/marketing/experiments/actions', () => ({
  createExperiment: async () => {}, setExperimentStatus: async () => {}, setExperimentWinner: async () => {},
}));
// The strategy tiles on /admin/reports have their own coverage and read other tables.
vi.mock('@/lib/metric/strategy-server', () => ({
  loadStrategyMetrics: async () => ({ rework: null, compression: null, compressionRead: 'failed' as const, conversion: null, referrals: null }),
}));
vi.mock('@/components/admin/strategy-metric-tiles', () => ({ StrategyMetricTiles: () => null }));
vi.mock('@/app/(app)/admin/marketing/loyalty/actions', () => ({
  saveLoyaltySettingsAction: async () => {}, awardPointsAction: async () => {},
  saveRewardAction: async () => ({ ok: true }), deleteRewardAction: async () => ({ ok: true }),
  fulfillRedemptionAction: async () => ({ ok: true }), cancelRedemptionAction: async () => ({ ok: true }),
}));

let db: InMemorySupabase;

beforeEach(() => {
  db = createInMemorySupabase({ maxRows: CAP });
  h.db = db;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-22T12:00:00Z'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The items of the banner titled `key` for a ceiling of `n`, or null when it is not on the page. */
function banner(html: string, key: 'adminCeiling.figuresNotShown' | 'adminCeiling.offeredInPart', n: number): string[] | null {
  const title = translate(SOURCE_MESSAGES, key, { n: n.toLocaleString() });
  const start = html.indexOf(`<p class="text-sm font-semibold text-danger">${title}</p>`);
  if (start < 0) return null;
  return [...html.slice(start, html.indexOf('</ul>', start)).matchAll(/<li>([^<]*)<\/li>/g)].map((m) => m[1]);
}

describe('/admin/backup: storage past its ceiling', () => {
  const CEILING = 25_000;
  async function render() {
    const { default: AdminDataPage } = await import('@/app/(app)/admin/backup/page');
    return renderServerPage(await AdminDataPage());
  }
  const docs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `doc-${pad(i)}`, family_id: 'fam-1', size_bytes: 1_000 }));

  it('costs the storage figure, which says so; the table counts and Stored documents stay', async () => {
    db.seed('documents', docs(CEILING + 1));
    const html = await render();
    expect(html).not.toContain(SOURCE_MESSAGES['backup.couldNotLoadDataAnd']);
    expect(statCardValue(html, SOURCE_MESSAGES['adminBackup.documentStorageUsed'])).toBe(UNAVAILABLE);
    expect(banner(html, 'adminCeiling.figuresNotShown', CEILING)).toEqual([SOURCE_MESSAGES['adminBackup.documentStorageUsed']]);
    expect(statCardValue(html, SOURCE_MESSAGES['adminBackup.storedDocuments'])).toBe((CEILING + 1).toLocaleString());
    expect(html).toContain(SOURCE_MESSAGES['adminBackup.tableSizes']);
  });

  it('a storage read that FAILS is still the read-error state', async () => {
    db.seed('documents', docs(10));
    h.db = withFaults(db, (_table, calls) => (calls.some((c) => c.method === 'select' && c.args[0] === 'id, size_bytes') ? { message: 'documents unavailable' } : null));
    expect(await render()).toContain(SOURCE_MESSAGES['backup.couldNotLoadDataAnd']);
  });

  it('the control: under the ceiling the storage is summed and nothing is withheld', async () => {
    db.seed('documents', docs(1300));
    const html = await render();
    expect(statCardValue(html, SOURCE_MESSAGES['adminBackup.documentStorageUsed'])).toBe('1.2 MB');
    expect(banner(html, 'adminCeiling.figuresNotShown', CEILING)).toBeNull();
  });
});

describe('/admin/wallet: the ledger volume past its ceiling', () => {
  const CEILING = 10_000;
  async function render() {
    const { default: AdminWalletPage } = await import('@/app/(app)/admin/wallet/page');
    return renderServerPage(await AdminWalletPage());
  }
  const txns = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `txn-${pad(i)}`, direction: 'credit', amount_cents: 100, status: 'completed' }));
  const volumes = [
    'adminWalletAdminWalletClient.totalCredits', 'adminWalletAdminWalletClient.totalDebits', 'adminWalletAdminWalletClient.netOutstanding',
  ].map((k) => SOURCE_MESSAGES[k]);

  it('the three volume figures say they are not shown, not $0.00 beside the failure banner', async () => {
    db.seed('wallet_transactions', txns(CEILING + 1));
    const html = await render();
    expect(html).not.toContain('Wallet oversight is incomplete');
    expect(banner(html, 'adminCeiling.figuresNotShown', CEILING)).toEqual(volumes);
    expect(html).toContain(`text-green-400">${UNAVAILABLE}</div>`);
    expect(html).toContain(`text-rose-400">${UNAVAILABLE}</div>`);
    expect(html).not.toContain(formatCents(0));
  });

  it('a ledger read that FAILS is still named in the failure banner', async () => {
    db.seed('wallet_transactions', txns(10));
    h.db = withFaults(db, (table) => (table === 'wallet_transactions' ? { message: 'ledger unavailable' } : null));
    const html = await render();
    expect(html).toContain('Wallet oversight is incomplete');
    expect(html).toContain('credit agg: ledger unavailable');
    expect(banner(html, 'adminCeiling.figuresNotShown', CEILING)).toBeNull();
  });

  it('the control: under the ceiling the volume is summed', async () => {
    db.seed('wallet_transactions', txns(1300));
    const html = await render();
    expect(html).toContain(`text-green-400">${formatCents(1300 * 100)}</div>`);
    expect(banner(html, 'adminCeiling.figuresNotShown', CEILING)).toBeNull();
  });
});

describe('/admin/marketing/affiliates: commissions past their ceiling', () => {
  const CEILING = 10_000;
  async function render() {
    const { default: AffiliatesPage } = await import('@/app/(app)/admin/marketing/affiliates/page');
    return renderServerPage(await AffiliatesPage());
  }
  function seed(referrals: number) {
    db.seed('affiliates', [{ id: 'aff-1', name: 'Partner', email: null, code: 'PARTNER', commission_rate: 0.2, status: 'active', created_at: '2026-01-01T00:00:00Z' }]);
    db.seed('affiliate_referrals', Array.from({ length: referrals }, (_, i) => ({ id: `ref-${pad(i)}`, affiliate_id: 'aff-1', status: 'converted', commission_cents: 100 })));
  }

  it('the tiles and each partner\'s figures say they are not shown; the partner, Pay out and the add form stay', async () => {
    seed(CEILING + 1);
    const html = await render();
    expect(html).not.toContain(SOURCE_MESSAGES['affiliates.couldNotLoadAffiliatePayout']);
    for (const label of ['Conversions', 'Owed (unpaid)', 'Paid out']) expect(statCardValue(html, label)).toBe(UNAVAILABLE);
    expect(banner(html, 'adminCeiling.figuresNotShown', CEILING)).toEqual(['Conversions', 'Owed (unpaid)', 'Paid out']);
    expect(html).toContain(`<td class="py-2">${UNAVAILABLE}</td><td class="py-2">${UNAVAILABLE}</td>`);
    expect(html).toContain('<p class="font-medium">Partner</p>');
    expect(html).toContain(SOURCE_MESSAGES['affiliates.payOut']);
    expect(html).toContain(SOURCE_MESSAGES['adminMarketingAffiliates.addAffiliate']);
  });

  it('a referral read that FAILS is still the read-error state', async () => {
    seed(10);
    h.db = withFaults(db, (table) => (table === 'affiliate_referrals' ? { message: 'referrals unavailable' } : null));
    expect(await render()).toContain(SOURCE_MESSAGES['affiliates.couldNotLoadAffiliatePayout']);
  });

  it('the control: under the ceiling the commissions are summed', async () => {
    seed(1300);
    const html = await render();
    expect(statCardValue(html, 'Conversions')).toBe('1300');
    expect(banner(html, 'adminCeiling.figuresNotShown', CEILING)).toBeNull();
  });
});

describe('/admin/marketing/intelligence: sessions and touchpoints past their ceilings', () => {
  async function render() {
    const { default: IntelligencePage } = await import('@/app/(app)/admin/marketing/intelligence/page');
    return renderServerPage(await IntelligencePage());
  }
  const sessions = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `ses-${pad(i)}`, visitor_id: `vis-${pad(i)}`, source: 'newsletter' }));
  const touchpoints = (n: number) => Array.from({ length: n }, (_, i) => ({
    id: `tp-${pad(i)}`, visitor_id: `vis-${pad(i)}`, source: 'newsletter', kind: i % 10 === 0 ? 'conversion' : 'visit',
    occurred_at: new Date(Date.UTC(2026, 9, 1) + i * 1_000).toISOString(),
  }));

  it('past 5,000 sessions the channels say they are not shown; the counts and the attribution stay', async () => {
    db.seed('mkt_visitors', [{ id: 'vis-1' }]);
    db.seed('mkt_sessions', sessions(5001));
    db.seed('mkt_touchpoints', touchpoints(20));
    const html = await render();
    expect(html).not.toContain(SOURCE_MESSAGES['intelligence.couldNotLoadCustomerIntelligence']);
    expect(banner(html, 'adminCeiling.figuresNotShown', 5000)).toEqual([SOURCE_MESSAGES['adminMarketingIntelligence.topAcquisitionChannels']]);
    expect(statCardValue(html, 'Sessions')).toBe('5001');
    expect(statCardValue(html, 'Touchpoints')).toBe('20');
    expect(html).not.toContain('newsletter</span><div class="h-2.5');
  });

  it('past 10,000 touchpoints Conversions, Touchpoints and the attribution say they are not shown', async () => {
    db.seed('mkt_visitors', [{ id: 'vis-1' }]);
    db.seed('mkt_sessions', sessions(10));
    db.seed('mkt_touchpoints', touchpoints(10_001));
    const html = await render();
    expect(html).not.toContain(SOURCE_MESSAGES['intelligence.couldNotLoadCustomerIntelligence']);
    expect(statCardValue(html, 'Conversions')).toBe(UNAVAILABLE);
    expect(statCardValue(html, 'Touchpoints')).toBe(UNAVAILABLE);
    expect(banner(html, 'adminCeiling.figuresNotShown', 10_000)).toEqual(['Conversions', 'Touchpoints', SOURCE_MESSAGES['adminMarketingIntelligence.attributionByModel']]);
    expect(statCardValue(html, 'Visitors')).toBe('1');
    expect(html).toContain('newsletter</span><div class="h-2.5');
  });

  it('a touchpoint read that FAILS is still the read-error state', async () => {
    db.seed('mkt_visitors', []);
    db.seed('mkt_sessions', sessions(10));
    h.db = withFaults(db, (table) => (table === 'mkt_touchpoints' ? { message: 'touchpoints unavailable' } : null));
    expect(await render()).toContain(SOURCE_MESSAGES['intelligence.couldNotLoadCustomerIntelligence']);
  });
});

describe('/admin/marketing/experiments: an experiment past the event ceiling', () => {
  const CEILING = 100_000;
  async function render() {
    const { default: ABTestingPage } = await import('@/app/(app)/admin/marketing/experiments/page');
    return renderServerPage(await ABTestingPage());
  }
  const experiment = (key: string, name: string, createdAt: string) => ({
    id: `exp-${key}`, key, name, status: 'running', metric: 'signup', hypothesis: null, winner: null, deleted_at: null,
    variants: [{ key: 'control', label: 'Control', weight: 50 }, { key: 'bold', label: 'Bold', weight: 50 }], created_at: createdAt,
  });
  const exposureCell = (n: number) => `<td class="py-2 text-right tabular-nums">${n.toLocaleString()}</td>`;

  it('costs that experiment\'s results, which say so; the other experiment, the controls and the form stay', async () => {
    db.seed('ab_experiments', [experiment('hero', 'Hero copy', '2026-09-02T00:00:00Z'), experiment('pricing', 'Pricing page', '2026-09-01T00:00:00Z')]);
    db.seed('ab_events', [
      ...Array.from({ length: CEILING + 1 }, (_, i) => ({ id: `abe-h-${String(i).padStart(7, '0')}`, experiment_key: 'hero', variant_key: 'control', kind: 'exposure' })),
      ...Array.from({ length: 7 }, (_, i) => ({ id: `abe-p-${pad(i)}`, experiment_key: 'pricing', variant_key: 'bold', kind: 'exposure' })),
    ]);
    const html = await render();
    expect(html).not.toContain(SOURCE_MESSAGES['experiments.couldNotLoadExperimentResults']);
    expect(banner(html, 'adminCeiling.figuresNotShown', CEILING)).toEqual(['Hero copy']);
    const hero = between(html, '>Hero copy</h2>', '>Pricing page</h2>');
    expect(hero).toContain(`<p class="text-sm text-muted">${UNAVAILABLE}</p>`);
    expect(hero).not.toContain('tabular-nums');
    expect(html.slice(at(html, '>Pricing page</h2>'))).toContain(exposureCell(7));
    expect(textOf(html)).toContain('key: hero');
  }, 120_000);

  it('an event read that FAILS is still the read-error state', async () => {
    db.seed('ab_experiments', [experiment('hero', 'Hero copy', '2026-09-02T00:00:00Z')]);
    db.seed('ab_events', [{ id: 'abe-1', experiment_key: 'hero', variant_key: 'control', kind: 'exposure' }]);
    h.db = withFaults(db, (table) => (table === 'ab_events' ? { message: 'events unavailable' } : null));
    expect(await render()).toContain(SOURCE_MESSAGES['experiments.couldNotLoadExperimentResults']);
  });
});

describe('/admin/reports: a chart past its ceiling', () => {
  const CEILING = 25_000;
  async function render() {
    const { default: AdminReportsPage } = await import('@/app/(app)/admin/reports/page');
    return renderServerPage(await AdminReportsPage());
  }
  const chart = (html: string, headingKey: string) => {
    const start = html.indexOf(`>${SOURCE_MESSAGES[headingKey]}</h2>`);
    if (start < 0) throw new Error(`no "${headingKey}" chart`);
    return html.slice(start, html.indexOf('</div>', start));
  };
  function seed(families: number) {
    db.seed('families', Array.from({ length: families }, (_, i) => ({ id: `fam-${pad(i)}`, created_at: '2026-09-15T00:00:00Z' })));
    for (const table of ['profiles', 'subscriptions', 'documents', 'audit_logs']) db.seed(table, []);
  }

  it('the families chart says it is not shown, not zero bars beside the banner; the count tile stays exact', async () => {
    seed(CEILING + 1);
    const html = await render();
    expect(chart(html, 'adminReports.newFamilies')).toContain(`<p class="text-sm text-muted">${UNAVAILABLE}</p>`);
    expect(banner(html, 'adminCeiling.figuresNotShown', CEILING)).toEqual([SOURCE_MESSAGES['adminReports.newFamilies']]);
    expect(html).not.toContain('This report is incomplete');
    expect(textOf(html)).toContain(`${(CEILING + 1).toLocaleString()} ${SOURCE_MESSAGES['adminReports.totalFamilies']}`);
    expect(chart(html, 'adminReports.newUsers')).not.toContain(UNAVAILABLE);
  });

  it('a families read that FAILS is named in the failure banner, and its chart is not drawn as zeros either', async () => {
    seed(10);
    h.db = withFaults(db, (_table, calls) => (calls.some((c) => c.method === 'select' && c.args[0] === 'id, created_at') && calls.some((c) => c.method === 'order')
      && _table === 'families' ? { message: 'families unavailable' } : null));
    const html = await render();
    expect(html).toContain('This report is incomplete');
    expect(html).toContain('families: families unavailable');
    expect(chart(html, 'adminReports.newFamilies')).toContain(UNAVAILABLE);
    expect(banner(html, 'adminCeiling.figuresNotShown', CEILING)).toBeNull();
  });
});

describe('/admin/marketing/loyalty: the award form\'s family picker', () => {
  const CEILING = 25_000;
  async function render() {
    const { default: LoyaltyPage } = await import('@/app/(app)/admin/marketing/loyalty/page');
    return renderServerPage(await LoyaltyPage());
  }
  function seedProgram(families: number) {
    db.seed('families', Array.from({ length: families }, (_, i) => ({ id: `fam-${pad(i)}`, name: `Family ${i}` })));
    db.seed('loyalty_settings', [{ singleton: true, enabled: true }]);
    for (const table of ['loyalty_rewards', 'loyalty_accounts', 'loyalty_redemptions']) db.seed(table, []);
  }
  const option = (i: number) => `<option value="fam-${pad(i)}">Family ${i}</option>`;

  it('offers every family past the first thousand, in id order', async () => {
    seedProgram(1300);
    const html = await render();
    for (const i of [0, CAP, 1299]) expect(html).toContain(option(i));
    expect(at(html, option(0))).toBeLessThan(at(html, option(1299)));
    expect(banner(html, 'adminCeiling.offeredInPart', CEILING)).toBeNull();
  });

  it('past 25,000 families offers the first 25,000 and says the list is cut short', async () => {
    seedProgram(CEILING + 1);
    const html = await render();
    expect(html).not.toContain(SOURCE_MESSAGES['loyalty.couldNotLoadLoyaltyData']);
    expect(html).toContain(option(CEILING - 1));
    expect(html).not.toContain(option(CEILING));
    expect(banner(html, 'adminCeiling.offeredInPart', CEILING)).toEqual([SOURCE_MESSAGES['adminMarketingLoyalty.awardFamilyPicker']]);
    expect(html).toContain(SOURCE_MESSAGES['adminMarketingLoyalty.awardAdjustPoints']);
  });

  it('a picker read that FAILS is still the read-error state', async () => {
    seedProgram(10);
    h.db = withFaults(db, (table, calls) => (table === 'families' && calls.some((c) => c.method === 'range') ? { message: 'families unavailable' } : null));
    expect(await render()).toContain(SOURCE_MESSAGES['loyalty.couldNotLoadLoyaltyData']);
  });
});
