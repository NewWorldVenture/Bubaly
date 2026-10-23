import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { createElement } from 'react';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { formatBytes } from '@/lib/marketing/assets';
import { createInMemorySupabase, withFaults, type FaultCall, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { renderServerPage, textOf } from './helpers/render-server-page';

// Marketing console figures that were counted or summed from a list read with
// `.limit(N)` — or an unbounded read, which PostgREST answers with at most
// db-max-rows (1,000) and no error — and shown as the whole set (coverage
// sweep round 9, class B): Affiliates, the asset library's count, size and
// kinds, "N campaigns", the lead-score bands, Active rewards, each
// personalization slot's count, the platform's Pages / Published / Templates,
// the push and exit-intent tiles, the inbound leads tiles, the recurring
// campaign tiles and the video catalog's count. Each is a head:true count or a
// sum paged on the id to a ceiling now, each list says when it holds part of
// the set, and a read that FAILS is the read-error state. The recurring page's
// failed run history said nothing (class A); it says it could not be read.
// Every case drives the REAL page against the in-memory database with
// PostgREST's 1,000-row cap.
const CAP = 1000;
const pad = (i: number) => String(i).padStart(6, '0');
const at = (k: number) => new Date(Date.UTC(2026, 0, 1) + k * 60_000).toISOString();

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db, describeConfiguredServiceKey: () => null }));
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
// The server actions and client controls behind the forms; none carries a number read here.
const noop = async () => ({ ok: true });
vi.mock('@/app/(app)/admin/marketing/affiliates/actions', () => ({ saveAffiliateAction: noop, toggleAffiliateStatusAction: noop, deleteAffiliateAction: noop, markAffiliatePaidAction: noop }));
vi.mock('@/app/(app)/admin/marketing/assets/actions', () => ({ uploadAssetAction: noop, updateAssetAction: noop, deleteAssetAction: noop }));
vi.mock('@/app/(app)/admin/marketing/video/actions', () => ({ saveVideoAction: noop, toggleVideoPublishAction: noop, deleteVideoAction: noop }));
vi.mock('@/app/(app)/admin/marketing/personalization/actions', () => ({ createRuleAction: noop, toggleRuleStatusAction: noop, deleteRuleAction: noop }));
vi.mock('@/app/(app)/admin/marketing/exit-intent/actions', () => ({ createExitIntentAction: noop, toggleExitIntentAction: noop, deleteExitIntentAction: noop }));
vi.mock('@/app/(app)/admin/marketing/push/actions', () => ({ createPushCampaignAction: noop, sendPushCampaignAction: noop, deletePushCampaignAction: noop, resolveStalePushCampaignAction: noop }));
vi.mock('@/app/(app)/admin/marketing/platform/actions', () => ({ archivePlatformPage: noop, createPlatformPage: noop, retryMarketingJob: noop, saveMarketingBrandRule: noop, saveMarketingTemplate: noop, updatePlatformPage: noop }));
vi.mock('@/app/(app)/admin/marketing/loyalty/actions', () => ({ saveLoyaltySettingsAction: noop, awardPointsAction: noop }));
vi.mock('@/app/(app)/admin/marketing/loyalty/reward-editor', () => ({ RewardRow: () => null, AddReward: () => null }));
vi.mock('@/app/(app)/admin/marketing/loyalty/redemption-row', () => ({ RedemptionRow: () => null }));
vi.mock('@/app/(app)/admin/marketing/lead-scores/lead-scores-client', () => ({ RecomputeButton: () => null, LeadRow: () => null }));
vi.mock('@/app/(app)/admin/marketing/social/recurring/controls', () => ({ RecurringAdControls: () => null, NewRecurringAdForm: () => null }));
vi.mock('@/lib/server/push', () => ({ pushConfigured: () => ({ web: true, native: true }) }));

let db: InMemorySupabase;
const m = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
const unavailable = SOURCE_MESSAGES['strategyMetrics.unavailable'];
const part = (key: string, shown: number, total: number) => m(key, { shown: shown.toLocaleString(), total: total.toLocaleString() });
const head = (calls: FaultCall[]) => calls.some((c) => c.method === 'select' && (c.args[1] as { head?: boolean } | undefined)?.head === true);
const eqTo = (calls: FaultCall[], column: string, value?: unknown) => calls.some((c) => c.method === 'eq' && c.args[0] === column && (value === undefined || c.args[1] === value));
/** Fault exactly the reads `failing` picks from `table`; returns how many it faulted. */
function fault(table: string, failing: (calls: FaultCall[]) => boolean) {
  const faulted = { n: 0 };
  h.db = withFaults(db, (name, calls) => {
    if (name !== table || !failing(calls)) return null;
    faulted.n += 1;
    return { message: `${table} unavailable` };
  });
  return faulted;
}
async function render(path: string): Promise<string> {
  const { default: Page } = await import(`@/app/(app)/admin/marketing/${path}/page`);
  return renderServerPage(await (Page as () => Promise<React.ReactElement>)());
}
/** The figure a tile shows above its label, for the `<p class=…>VALUE</p><p class=…>LABEL</p>` shape most tiles share. */
const tile = (html: string, label: string) =>
  new RegExp(`<p class="[^"]*">([^<]*)</p><p class="[^"]*text-muted[^"]*">${label}</p>`).exec(html)?.[1]
  ?? new RegExp(`<p class="text-xs text-muted">${label}</p><p class="[^"]*">([^<]*)</p>`).exec(html)?.[1];

beforeEach(() => {
  db = createInMemorySupabase({ maxRows: CAP });
  h.db = db;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('/admin/marketing/affiliates: the Affiliates tile', () => {
  const affiliate = (k: number): Row => ({ id: `aff-${pad(k)}`, name: `Partner ${k}`, email: null, code: `code${k}`, commission_rate: 0.1, status: 'active', created_at: at(k) });
  const seed = (n: number) => { db.seed('affiliates', Array.from({ length: n }, (_, k) => affiliate(k))); db.seed('affiliate_referrals', []); };
  const readError = SOURCE_MESSAGES['affiliates.couldNotLoadAffiliatePayout'];

  it('counts every partner past the 200 listed, and the list says it is part', async () => {
    seed(250);
    const html = await render('affiliates');
    expect(tile(html, m('affiliates.affiliates'))).toBe('250');
    expect(textOf(html)).toContain(part('adminCeiling.listShowsTheNewest', 200, 250));
  });
  it('a count that FAILS is the read-error state', async () => {
    seed(250);
    const faulted = fault('affiliates', head);
    expect(await render('affiliates')).toContain(readError);
    expect(faulted.n).toBe(1);
  });
  it('the control: under the list the tile is the list and nothing is said', async () => {
    seed(3);
    const html = await render('affiliates');
    expect(tile(html, m('affiliates.affiliates'))).toBe('3');
    expect(textOf(html)).not.toContain(part('adminCeiling.listShowsTheNewest', 3, 3).slice(0, 30));
  });
});

describe('/admin/marketing/assets: the library count, size and kinds', () => {
  const asset = (k: number): Row => ({
    id: `ast-${pad(k)}`, name: `Asset ${k}`, kind: 'document', mime_type: 'application/pdf', size_bytes: 1000, storage_path: `p/${k}.pdf`,
    tags: [], alt_text: null, license: 'original', source_url: null, attribution: null, deleted_at: null, created_at: at(k),
  });
  const readError = SOURCE_MESSAGES['assets.couldNotLoadMarketingAssets'];

  it('counts and sums every asset past the 300 listed, and the library says it is part', async () => {
    db.seed('marketing_assets', Array.from({ length: 350 }, (_, k) => asset(k)));
    const page = textOf(await render('assets'));
    expect(page).toContain(`350 assets · ${formatBytes(350_000)}`);
    expect(page).toContain(`${part('adminCeiling.listShowsTheNewest', 300, 350)}`);
    expect(page).toContain('Documents (350)');
  });
  it('past the size\'s ceiling the size alone says it is not shown', async () => {
    db.seed('marketing_assets', Array.from({ length: 10_001 }, (_, k) => asset(k)));
    const page = textOf(await render('assets'));
    expect(page).toContain(`10,001 assets · ${unavailable}`);
    expect(page).toContain(`${m('adminCeiling.figuresNotShown', { n: '10,000' })} ${m('adminMarketingAssets.totalSize')}`);
  });
  it.each([
    ['the count', (c: FaultCall[]) => head(c) && !eqTo(c, 'kind')],
    ['one kind\'s count', (c: FaultCall[]) => head(c) && eqTo(c, 'kind', 'document')],
    ['the size', (c: FaultCall[]) => c.some((call) => call.method === 'select' && call.args[0] === 'id, size_bytes')],
  ])('a read that FAILS (%s) is the read-error state', async (_, failing) => {
    db.seed('marketing_assets', Array.from({ length: 350 }, (_, k) => asset(k)));
    const faulted = fault('marketing_assets', failing);
    expect(await render('assets')).toContain(readError);
    expect(faulted.n).toBe(1);
  });
  it('the control: a library that fits the list is counted the same', async () => {
    db.seed('marketing_assets', [asset(1), asset(2)]);
    const page = textOf(await render('assets'));
    expect(page).toContain(`2 assets · ${formatBytes(2000)}`);
    expect(page).not.toContain(part('adminCeiling.listShowsTheNewest', 2, 2).slice(0, 30));
  });
});

describe('/admin/marketing/campaigns: "N campaigns"', () => {
  const campaign = (k: number): Row => ({ id: `cmp-${pad(k)}`, name: `Campaign ${k}`, channel: 'email', type: 'one_off', status: 'draft', budget_cents: 0, deleted_at: null, created_at: at(k), starts_at: null, ends_at: null });
  it('counts every campaign past the 1,000 the list holds', async () => {
    db.seed('marketing_campaigns', Array.from({ length: 1200 }, (_, k) => campaign(k)));
    const page = textOf(await render('campaigns'));
    expect(page).toContain('1,200 campaigns');
    expect(page).toContain(part('adminCeiling.listShowsTheNewest', 1000, 1200));
  });
  it('a count that FAILS is the read-error state', async () => {
    db.seed('marketing_campaigns', [campaign(1)]);
    fault('marketing_campaigns', head);
    expect(await render('campaigns')).toContain(SOURCE_MESSAGES['campaigns.couldNotLoadMarketingCampaigns']);
  });
  it('the control: a few campaigns are counted the same', async () => {
    db.seed('marketing_campaigns', [campaign(1), campaign(2)]);
    expect(textOf(await render('campaigns'))).toContain('2 campaigns');
  });
});

describe('/admin/marketing/lead-scores: the band tiles', () => {
  /** 100 hot leads at the top, and 50 qualified ones below the 100 listed. */
  function seed() {
    db.seed('crm_lead_scores', [
      ...Array.from({ length: 100 }, (_, k) => ({ contact_id: `ct-h-${pad(k)}`, score: 90, band: 'hot', factors: [] })),
      ...Array.from({ length: 50 }, (_, k) => ({ contact_id: `ct-q-${pad(k)}`, score: 10, band: 'qualified', factors: [] })),
    ]);
    db.seed('crm_contacts', []);
  }
  const stat = (html: string, label: string) => new RegExp(`<p class="text-2xl font-black tabular-nums">([^<]*)</p><p class="text-xs text-muted">${label}</p>`).exec(html)?.[1];

  it('each band counts every score, not the top 100 listed', async () => {
    seed();
    const html = await render('lead-scores');
    expect(stat(html, 'Scored contacts')).toBe('150');
    expect(stat(html, 'Qualified')).toBe('50');
    expect(stat(html, 'Hot')).toBe('100');
    expect(textOf(html)).toContain(part('adminCeiling.listShowsPart', 100, 150));
  });
  it('a band count that FAILS is the read-error state', async () => {
    seed();
    fault('crm_lead_scores', (c) => head(c) && eqTo(c, 'band', 'qualified'));
    expect(await render('lead-scores')).toContain(SOURCE_MESSAGES['leadScores.couldNotLoadLeadScores']);
  });
  it('the control: a few scores are counted the same', async () => {
    db.seed('crm_lead_scores', [{ contact_id: 'ct-1', score: 50, band: 'warm', factors: [] }]);
    db.seed('crm_contacts', []);
    const html = await render('lead-scores');
    expect(stat(html, 'Warm')).toBe('1');
    expect(textOf(html)).not.toContain(part('adminCeiling.listShowsPart', 1, 1).slice(0, 30));
  });
});

describe('/admin/marketing/loyalty: Active rewards', () => {
  const reward = (k: number, active: boolean): Row => ({ id: `rw-${pad(k)}`, name: `Reward ${k}`, cost_points: 10, is_active: active, sort: k, deleted_at: null, created_at: at(k) });
  function seed(inactive: number, active: number) {
    db.seed('loyalty_settings', [{ singleton: true, enabled: true }]);
    db.seed('loyalty_rewards', [
      ...Array.from({ length: inactive }, (_, k) => reward(k, false)),
      ...Array.from({ length: active }, (_, k) => reward(inactive + k, true)),
    ]);
    for (const table of ['loyalty_accounts', 'loyalty_redemptions', 'families']) db.seed(table, []);
  }
  const stat = (html: string, label: string) => new RegExp(`${label}</p><p class="mt-1 text-3xl font-bold leading-none">([^<]*)</p>`).exec(html)?.[1];

  it('counts the active rewards past the 200 the catalog lists, and the catalog says it is part', async () => {
    seed(200, 50);
    const html = await render('loyalty');
    expect(stat(html, m('adminMarketingLoyalty.activeRewards'))).toBe('50');
    expect(textOf(html)).toContain(part('adminCeiling.listShowsPart', 200, 250));
  });
  it('an active-reward count that FAILS is the read-error state', async () => {
    seed(200, 50);
    fault('loyalty_rewards', (c) => head(c) && eqTo(c, 'is_active', true));
    expect(await render('loyalty')).toContain(SOURCE_MESSAGES['loyalty.couldNotLoadLoyaltyData']);
  });
  it('the control: a catalog that fits the list is counted the same', async () => {
    seed(1, 2);
    const html = await render('loyalty');
    expect(stat(html, m('adminMarketingLoyalty.activeRewards'))).toBe('2');
    expect(textOf(html)).not.toContain(part('adminCeiling.listShowsPart', 3, 3).slice(0, 30));
  });
});

describe('/admin/marketing/personalization: each slot\'s count', () => {
  const rule = (k: number, slot: string): Row => ({ id: `pr-${pad(k)}`, slot, name: `Rule ${k}`, priority: k, status: 'active', match: {}, variant: {}, deleted_at: null, created_at: at(k), impressions: 0, conversions: 0 });
  it('counts every rule of the listed slot past the 300 listed, and the list says it is part', async () => {
    db.seed('marketing_personalization_rules', Array.from({ length: 310 }, (_, k) => rule(k, 'hero')));
    const page = textOf(await render('personalization'));
    expect(page).toContain('hero (310)');
    expect(page).toContain(part('adminCeiling.listShowsPart', 300, 310));
  });
  it('a slot count that FAILS is the read-error state', async () => {
    db.seed('marketing_personalization_rules', Array.from({ length: 3 }, (_, k) => rule(k, 'hero')));
    fault('marketing_personalization_rules', (c) => head(c) && eqTo(c, 'slot', 'hero'));
    expect(await render('personalization')).toContain(SOURCE_MESSAGES['personalization.couldNotLoadPersonalizationRules']);
  });
  it('the control: a few rules are counted the same', async () => {
    db.seed('marketing_personalization_rules', [rule(1, 'hero'), rule(2, 'banner')]);
    const page = textOf(await render('personalization'));
    expect(page).toContain('hero (1)');
    expect(page).not.toContain(part('adminCeiling.listShowsPart', 2, 2).slice(0, 30));
  });
});

describe('/admin/marketing/platform: Pages, Published and Templates', () => {
  const page = (k: number, status: string): Row => ({
    id: `mp-${pad(k)}`, title: `Page ${k}`, slug: `page-${k}`, page_type: 'guide', status, summary: null, body: null, path: `/guides/page-${k}`,
    deleted_at: null, updated_at: at(k), created_at: at(k), version: 1, published_at: null, metadata: {},
  });
  function seed(published: number, drafts: number) {
    // The published pages were updated FIRST: the 40 most recent are drafts.
    db.seed('marketing_pages', [
      ...Array.from({ length: published }, (_, k) => page(k, 'published')),
      ...Array.from({ length: drafts }, (_, k) => page(published + k, 'draft')),
    ]);
    for (const table of ['marketing_content_templates', 'marketing_brand_rules', 'marketing_generation_jobs', 'marketing_provider_syncs', 'marketing_provider_observations', 'marketing_embeddings']) db.seed(table, []);
  }
  const metric = (html: string, label: string) => new RegExp(`<span class="block text-lg[^"]*">([^<]*)</span><span class="block text-\\[11px\\] text-muted">${label}</span>`).exec(html)?.[1];

  it('count every page past the 40 the registry lists, and the registry says it is part', async () => {
    seed(10, 40);
    const html = await render('platform');
    expect(metric(html, m('adminMarketingPlatform.pages'))).toBe('50');
    expect(metric(html, m('adminMarketingPlatform.published'))).toBe('10');
    expect(textOf(html)).toContain(part('adminCeiling.listShowsPart', 40, 50));
  });
  it('a page count that FAILS is the read-error state', async () => {
    seed(10, 40);
    fault('marketing_pages', (c) => head(c) && eqTo(c, 'status', 'published'));
    expect(await render('platform')).toContain(SOURCE_MESSAGES['platform.couldNotLoadTheMarketing']);
  });
  it('the control: a registry that fits the list is counted the same', async () => {
    seed(1, 1);
    const html = await render('platform');
    expect(metric(html, m('adminMarketingPlatform.pages'))).toBe('2');
    expect(metric(html, m('adminMarketingPlatform.published'))).toBe('1');
  });
});

describe('/admin/marketing/push: Campaigns, Accepted and Review', () => {
  const campaign = (k: number, status: string, sent: number): Row => ({
    id: `pc-${pad(k)}`, title: `Push ${k}`, body: null, url: null, status, sent, recipients: sent, failed: 0, skipped: 0,
    metadata: {}, deleted_at: null, created_at: at(k), updated_at: at(k), sent_at: null,
  });
  /** 50 sent campaigns, older than the 200 drafts the list holds. */
  function seed(drafts = 200) {
    db.seed('marketing_push_campaigns', [
      ...Array.from({ length: 50 }, (_, k) => campaign(k, 'sent', 10)),
      ...Array.from({ length: drafts }, (_, k) => campaign(50 + k, 'draft', 0)),
    ]);
    db.seed('push_devices', []);
  }
  const stat = (html: string, label: string) => new RegExp(`<p class="text-xs text-muted">${label}</p><p class="text-xl font-semibold">([^<]*)</p>`).exec(html)?.[1];

  it('count and sum every campaign past the 200 listed', async () => {
    seed();
    const html = await render('push');
    expect(stat(html, 'Campaigns')).toBe('250');
    expect(stat(html, m('marketingPush.accepted'))).toBe('500');
    expect(textOf(html)).toContain(part('adminCeiling.listShowsTheNewest', 200, 250));
  });
  it('past the summary\'s ceiling Accepted and Review say they are not shown', async () => {
    seed(10_000);
    const html = await render('push');
    expect(stat(html, 'Campaigns')).toBe('10050');
    expect(stat(html, m('marketingPush.accepted'))).toBe(unavailable);
    expect(stat(html, m('marketingPush.review'))).toBe(unavailable);
  });
  it.each([
    ['the count', head],
    ['the summary', (c: FaultCall[]) => c.some((call) => call.method === 'select' && call.args[0] === 'id, status, sent, recipients, metadata')],
  ])('a read that FAILS (%s) is the read-error state', async (_, failing) => {
    seed();
    fault('marketing_push_campaigns', failing);
    expect(await render('push')).toContain(SOURCE_MESSAGES['push.couldNotLoadPushCampaigns']);
  });
  it('the control: a few campaigns are counted the same', async () => {
    db.seed('marketing_push_campaigns', [campaign(1, 'sent', 3)]);
    db.seed('push_devices', []);
    const html = await render('push');
    expect(stat(html, 'Campaigns')).toBe('1');
    expect(stat(html, m('marketingPush.accepted'))).toBe('3');
  });
});

describe('/admin/marketing/exit-intent: the offer tiles', () => {
  const offer = (k: number, priority: number, status: string, impressions: number): Row => ({
    id: `ei-${pad(k)}`, name: `Offer ${k}`, headline: 'Wait', body: null, cta_label: null, cta_url: null, priority, status, impressions, conversions: 0,
    match: {}, trigger_config: {}, deleted_at: null, created_at: at(k),
  });
  /** 50 active offers at priority 0, below the 200 inactive ones the list holds. */
  function seed() {
    db.seed('marketing_exit_intent', [
      ...Array.from({ length: 200 }, (_, k) => offer(k, 10, 'paused', 0)),
      ...Array.from({ length: 50 }, (_, k) => offer(200 + k, 0, 'active', 100)),
    ]);
  }
  const stat = (html: string, label: string) => new RegExp(`<p class="text-xs text-muted">${label}</p><p class="text-xl font-semibold">([^<]*)</p>`).exec(html)?.[1];
  it('count and sum every offer past the 200 listed', async () => {
    seed();
    const html = await render('exit-intent');
    expect(stat(html, 'Offers')).toBe('250');
    expect(stat(html, 'Active')).toBe('50');
    expect(stat(html, 'Impressions')).toBe('5000');
    expect(textOf(html)).toContain(part('adminCeiling.listShowsPart', 200, 250));
  });
  it('a summary that FAILS is the read-error state', async () => {
    seed();
    fault('marketing_exit_intent', (c) => c.some((call) => call.method === 'select' && call.args[0] === 'id, status, impressions, conversions'));
    expect(await render('exit-intent')).toContain(SOURCE_MESSAGES['exitIntent.couldNotLoadExitIntent']);
  });
  it('the control: a few offers are counted the same', async () => {
    db.seed('marketing_exit_intent', [offer(1, 0, 'active', 7)]);
    const html = await render('exit-intent');
    expect(stat(html, 'Offers')).toBe('1');
    expect(stat(html, 'Impressions')).toBe('7');
  });
});

describe('/admin/marketing/leads: the inbound lead tiles', () => {
  const lead = (k: number, status: string): Row => ({
    id: `ld-${pad(k)}`, subject: `Lead ${k}`, description: 'Hello', requester_name: `Person ${k}`, requester_email: `p${k}@example.com`,
    status, created_at: at(k), family_id: null, tags: ['contact-form'],
  });
  function seed(open: number, resolved: number) {
    db.seed('support_tickets', [
      ...Array.from({ length: open }, (_, k) => lead(k, 'open')),
      ...Array.from({ length: resolved }, (_, k) => lead(open + k, 'resolved')),
    ]);
    for (const table of ['families', 'subscriptions', 'family_members', 'profiles']) db.seed(table, []);
  }
  it('counts every lead past the 100 read for the list, and the list says it is part', async () => {
    seed(50, 100);
    const html = await render('leads');
    expect(tile(html, 'Total Leads')).toBe('150');
    expect(tile(html, 'Open')).toBe('50');
    expect(textOf(html)).toContain(part('adminCeiling.listShowsPart', 60, 150));
  });
  it('the lead read that FAILS is the read-error state', async () => {
    seed(50, 100);
    fault('support_tickets', (c) => c.some((call) => call.method === 'select' && call.args[0] === 'id, description, requester_name, requester_email, status, created_at, family_id'));
    expect(await render('leads')).toContain(SOURCE_MESSAGES['leads.couldNotLoadLeadScoring']);
  });
  it('the control: a few leads are counted the same', async () => {
    seed(1, 2);
    const html = await render('leads');
    expect(tile(html, 'Total Leads')).toBe('3');
    expect(tile(html, 'Open')).toBe('1');
    expect(textOf(html)).not.toContain(part('adminCeiling.listShowsPart', 3, 3).slice(0, 30));
  });
});

describe('/admin/marketing/social/recurring: the campaign tiles and the run history', () => {
  const ad = (k: number, status: string): Row => ({
    id: `ra-${pad(k)}`, name: `Recurring ${k}`, status, platforms: ['x'], body_variants: ['Hi'], occurrences: 2, max_occurrences: null,
    cadence: 'weekly', starts_at: at(k), ends_at: null, next_run_at: null, last_run_at: null, deleted_at: null, created_at: at(k), timezone: 'UTC',
  });
  const stat = (html: string, label: string) => new RegExp(`<p class="text-xs text-muted">${label}</p><p class="text-2xl font-bold">([^<]*)</p>`).exec(html)?.[1];
  it('count every campaign past the 1,000 the list holds', async () => {
    db.seed('marketing_recurring_ads', Array.from({ length: 1100 }, (_, k) => ad(k, k < 100 ? 'active' : 'paused')));
    db.seed('marketing_recurring_ad_runs', []);
    const html = await render('social/recurring');
    expect(stat(html, 'Campaigns')).toBe('1100');
    expect(stat(html, 'Active')).toBe('100');
    expect(stat(html, 'Posts sent')).toBe('2200');
  });
  it('a run history read that FAILS says so on each campaign, not nothing', async () => {
    db.seed('marketing_recurring_ads', [ad(1, 'active')]);
    db.seed('marketing_recurring_ad_runs', [{ id: 'run-1', ad_id: 'ra-000001', occurrence: 0, platform: 'x', status: 'published', ran_at: at(2), error_message: null, permalink_url: null }]);
    fault('marketing_recurring_ad_runs', () => true);
    const page = textOf(await render('social/recurring'));
    expect(page).toContain(m('adminRecurringAds.runHistoryUnavailable'));
    expect(page).not.toContain('Recent runs');
  });
  it('a campaign count that FAILS is the read-error state', async () => {
    db.seed('marketing_recurring_ads', [ad(1, 'active')]);
    db.seed('marketing_recurring_ad_runs', []);
    fault('marketing_recurring_ads', head);
    expect(textOf(await render('social/recurring'))).toContain('Recurring campaigns could not be read');
  });
  it('the control: the run history shows, and a few campaigns are counted the same', async () => {
    db.seed('marketing_recurring_ads', [ad(1, 'active')]);
    db.seed('marketing_recurring_ad_runs', [{ id: 'run-1', ad_id: 'ra-000001', occurrence: 0, platform: 'x', status: 'published', ran_at: at(2), error_message: null, permalink_url: null }]);
    const html = await render('social/recurring');
    expect(textOf(html)).toContain('Recent runs (1)');
    expect(textOf(html)).not.toContain(m('adminRecurringAds.runHistoryUnavailable'));
    expect(stat(html, 'Campaigns')).toBe('1');
  });
});

describe('/admin/marketing/video: the catalog count and the upload picker', () => {
  const video = (k: number, status: string): Row => ({
    id: `vd-${pad(k)}`, title: `Video ${k}`, status, provider: 'youtube', url: 'https://youtu.be/x', asset_id: null, poster_url: null,
    duration_seconds: null, transcript: null, tags: [], license: 'embedded_source', attribution: null, deleted_at: null, created_at: at(k),
  });
  const upload = (k: number): Row => ({ id: `va-${pad(k)}`, name: `Upload ${k}`, kind: 'video', deleted_at: null, created_at: at(k) });
  it('counts every video past the 300 listed, and the picker says it offers part of the uploads', async () => {
    db.seed('marketing_videos', [
      ...Array.from({ length: 50 }, (_, k) => video(k, 'published')),
      ...Array.from({ length: 300 }, (_, k) => video(50 + k, 'draft')),
    ]);
    db.seed('marketing_assets', Array.from({ length: 250 }, (_, k) => upload(k)));
    const page = textOf(await render('video'));
    expect(page).toContain(`350 videos · 50 ${m('adminMarketingVideo.publishedPasteAUrlOrPick')}`);
    expect(page).toContain(part('adminCeiling.listShowsTheNewest', 300, 350));
    expect(page).toContain(m('adminCeiling.pickerOffersTheNewest', { picker: m('adminMarketingVideo.uploadedVideo'), shown: '200', total: '250' }));
  });
  it('a published count that FAILS is the read-error state', async () => {
    db.seed('marketing_videos', [video(1, 'published')]);
    db.seed('marketing_assets', []);
    fault('marketing_videos', (c) => head(c) && eqTo(c, 'status', 'published'));
    expect(await render('video')).toContain(SOURCE_MESSAGES['video.couldNotLoadMarketingVideos']);
  });
  it('the control: a few videos are counted the same, and the picker offers every upload', async () => {
    db.seed('marketing_videos', [video(1, 'published'), video(2, 'draft')]);
    db.seed('marketing_assets', [upload(1)]);
    const page = textOf(await render('video'));
    expect(page).toContain(`2 videos · 1 ${m('adminMarketingVideo.publishedPasteAUrlOrPick')}`);
    expect(page).not.toContain(m('adminCeiling.pickerOffersTheNewest', { picker: m('adminMarketingVideo.uploadedVideo'), shown: '1', total: '1' }).slice(0, 20));
  });
});
