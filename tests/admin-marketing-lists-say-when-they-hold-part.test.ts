import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { createElement } from 'react';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, withFaults, type FaultCall, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { renderServerPage, textOf } from './helpers/render-server-page';

// Marketing pages whose tiles count the whole set (earlier rounds) beside a
// list read with `.limit(N)`, and a contact picker offering the newest 500
// contacts, none of which said it held only part of the set (coverage sweep
// round 9, class B: "a list that shows only part of the set says so"). CRM
// contacts, competitors and backlinks, quotes and the quote and deal contact
// pickers, loyalty members and redemptions, reviews, and a survey's responses
// now say so, against a head:true count (or the paged rows the tiles already
// add up). A new count that FAILS is the read-error state. The REAL pages,
// in-memory database with PostgREST's 1,000-row cap.
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
const noop = async () => ({ ok: true });
vi.mock('@/app/(app)/admin/marketing/crm/actions', () => ({ saveContactAction: noop, deleteContactAction: noop, saveDealAction: noop, setDealStageAction: noop, deleteDealAction: noop }));
vi.mock('@/app/(app)/admin/marketing/competitive/actions', () => ({ saveCompetitorAction: noop, deleteCompetitorAction: noop, saveKeywordAction: noop, deleteKeywordAction: noop, saveBacklinkAction: noop, deleteBacklinkAction: noop }));
vi.mock('@/app/(app)/admin/marketing/proposals/actions', () => ({ saveQuoteAction: noop, setQuoteStatusAction: noop, deleteQuoteAction: noop }));
vi.mock('@/app/(app)/admin/marketing/reviews/actions', () => ({ moderateReviewAction: noop, replyToReviewAction: noop, deleteReviewAction: noop, saveReputationSettingsAction: noop }));
vi.mock('@/app/(app)/admin/marketing/reviews/review-row', () => ({ ReviewRow: () => null }));
vi.mock('@/app/(app)/admin/marketing/surveys/[id]/survey-controls', () => ({ SurveyControls: () => null }));
vi.mock('@/app/(app)/admin/marketing/loyalty/actions', () => ({ saveLoyaltySettingsAction: noop, awardPointsAction: noop }));
vi.mock('@/app/(app)/admin/marketing/loyalty/reward-editor', () => ({ RewardRow: () => null, AddReward: () => null }));
vi.mock('@/app/(app)/admin/marketing/loyalty/redemption-row', () => ({ RedemptionRow: () => null }));
vi.mock('@/app/(app)/admin/marketing/platform/actions', () => ({ archivePlatformPage: noop, createPlatformPage: noop, retryMarketingJob: noop, saveMarketingBrandRule: noop, saveMarketingTemplate: noop, updatePlatformPage: noop }));
vi.mock('@/app/(app)/admin/marketing/social/recurring/controls', () => ({ RecurringAdControls: () => null, NewRecurringAdForm: () => null }));
vi.mock('@/app/(app)/admin/marketing/actions', () => ({ addKeyword: noop, archiveSeoKeyword: noop, archiveSeoPage: noop, saveSeoPage: noop, updateSeoKeyword: noop }));

let db: InMemorySupabase;
const m = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
const part = (key: string, shown: number, total: number) => m(key, { shown: shown.toLocaleString(), total: total.toLocaleString() });
const head = (calls: FaultCall[]) => calls.some((c) => c.method === 'select' && (c.args[1] as { head?: boolean } | undefined)?.head === true);
async function render(path: string, props: Record<string, unknown> = {}): Promise<string> {
  const { default: Page } = await import(`@/app/(app)/admin/marketing/${path}/page`);
  return textOf(await renderServerPage(await (Page as (p: unknown) => Promise<React.ReactElement>)(props)));
}
const contact = (k: number): Row => ({
  id: `ct-${pad(k)}`, first_name: `First${k}`, last_name: null, email: `c${k}@example.com`, company: null, lifecycle_stage: 'lead',
  lead_status: 'new', lead_source: null, owner_id: null, family_id: null, created_at: at(k), updated_at: at(k), tags: [],
});

beforeEach(() => {
  db = createInMemorySupabase({ maxRows: CAP });
  h.db = db;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('/admin/marketing/crm: the contact list', () => {
  it('says it holds the newest 500 of every contact', async () => {
    db.seed('crm_contacts', Array.from({ length: 600 }, (_, k) => contact(k)));
    expect(await render('crm')).toContain(part('adminCeiling.listShowsTheNewest', 500, 600));
  });
  it('the control: a list that holds every contact says nothing', async () => {
    db.seed('crm_contacts', [contact(1)]);
    expect(await render('crm')).not.toContain(part('adminCeiling.listShowsTheNewest', 1, 1).slice(0, 30));
  });
});

describe('/admin/marketing/competitive: competitors and backlinks', () => {
  function seed(competitors: number, backlinks: number) {
    db.seed('competitors', Array.from({ length: competitors }, (_, k) => ({ id: `cp-${pad(k)}`, name: `Rival ${k}`, domain: null, ranking: k + 1, created_at: at(k) })));
    db.seed('backlinks', Array.from({ length: backlinks }, (_, k) => ({ id: `bl-${pad(k)}`, source_domain: `s${k}.example`, target_url: '/', authority: 10, status: 'active', created_at: at(k) })));
    db.seed('keyword_intel', []);
  }
  it('each list says it holds part', async () => {
    seed(250, 600);
    const page = await render('competitive');
    expect(page).toContain(part('adminCeiling.listShowsPart', 200, 250));
    expect(page).toContain(part('adminCeiling.listShowsTheNewest', 500, 600));
  });
  it('the control: lists that hold everything say nothing', async () => {
    seed(2, 2);
    const page = await render('competitive');
    expect(page).not.toContain(part('adminCeiling.listShowsPart', 2, 2).slice(0, 30));
    expect(page).not.toContain(part('adminCeiling.listShowsTheNewest', 2, 2).slice(0, 30));
  });
});

describe('/admin/marketing/proposals and /pipeline: the quote list and the contact pickers', () => {
  const quote = (k: number): Row => ({ id: `qt-${pad(k)}`, title: `Quote ${k}`, contact_id: null, amount_cents: 100, status: 'draft', valid_until: null, created_at: at(k) });
  it('the quote list and the picker say they hold part', async () => {
    db.seed('crm_quotes', Array.from({ length: 600 }, (_, k) => quote(k)));
    db.seed('crm_contacts', Array.from({ length: 550 }, (_, k) => contact(k)));
    const page = await render('proposals');
    expect(page).toContain(part('adminCeiling.listShowsTheNewest', 500, 600));
    expect(page).toContain(m('adminCeiling.pickerOffersTheNewest', { picker: m('adminMarketingProposals.contact'), shown: '500', total: '550' }));
  });
  it('the deal picker says it offers part of the contacts', async () => {
    db.seed('crm_deals', []);
    db.seed('crm_contacts', Array.from({ length: 550 }, (_, k) => contact(k)));
    expect(await render('pipeline')).toContain(m('adminCeiling.pickerOffersTheNewest', { picker: m('adminMarketingPipeline.contact'), shown: '500', total: '550' }));
  });
  it.each(['proposals', 'pipeline'])('a contact count that FAILS is the read-error state (%s)', async (path) => {
    db.seed('crm_quotes', []);
    db.seed('crm_deals', []);
    db.seed('crm_contacts', [contact(1)]);
    h.db = withFaults(db, (table, calls) => (table === 'crm_contacts' && head(calls) ? { message: 'crm_contacts unavailable' } : null));
    const page = await render(path);
    expect(page).toContain(path === 'proposals' ? SOURCE_MESSAGES['proposals.couldNotLoadProposalsFrom'] : SOURCE_MESSAGES['pipeline.couldNotLoadTheSales']);
  });
  it('the control: a picker that offers every contact says nothing', async () => {
    db.seed('crm_quotes', [quote(1)]);
    db.seed('crm_deals', []);
    db.seed('crm_contacts', [contact(1)]);
    expect(await render('proposals')).not.toContain(m('adminCeiling.pickerOffersTheNewest', { picker: m('adminMarketingProposals.contact'), shown: '1', total: '1' }).slice(0, 20));
    expect(await render('pipeline')).not.toContain(m('adminCeiling.pickerOffersTheNewest', { picker: m('adminMarketingPipeline.contact'), shown: '1', total: '1' }).slice(0, 20));
  });
});

describe('/admin/marketing/loyalty: the member and redemption lists', () => {
  function seed(accounts: number, redemptions: number) {
    db.seed('loyalty_settings', [{ singleton: true, enabled: true }]);
    db.seed('loyalty_rewards', []);
    db.seed('loyalty_accounts', Array.from({ length: accounts }, (_, k) => ({ id: `la-${pad(k)}`, family_id: 'fam-1', points_balance: 1, lifetime_points: k, created_at: at(k) })));
    db.seed('loyalty_redemptions', Array.from({ length: redemptions }, (_, k) => ({ id: `lr-${pad(k)}`, family_id: 'fam-1', reward_name: 'Prize', cost_points: 1, status: 'fulfilled', code: null, notes: null, created_at: at(k) })));
    db.seed('families', [{ id: 'fam-1', name: 'Family 1' }]);
  }
  it('each list says it holds part', async () => {
    seed(150, 130);
    const page = await render('loyalty');
    expect(page).toContain(part('adminCeiling.listShowsPart', 100, 150));
    expect(page).toContain(part('adminCeiling.listShowsTheNewest', 100, 130));
  });
  it('a redemption count that FAILS is the read-error state', async () => {
    seed(1, 1);
    h.db = withFaults(db, (table, calls) => (table === 'loyalty_redemptions' && head(calls) && !calls.some((c) => c.method === 'eq') ? { message: 'loyalty_redemptions unavailable' } : null));
    expect(await render('loyalty')).toContain(SOURCE_MESSAGES['loyalty.couldNotLoadLoyaltyData']);
  });
  it('the control: lists that hold everything say nothing', async () => {
    seed(2, 2);
    const page = await render('loyalty');
    expect(page).not.toContain(part('adminCeiling.listShowsPart', 2, 2).slice(0, 30));
    expect(page).not.toContain(part('adminCeiling.listShowsTheNewest', 2, 2).slice(0, 30));
  });
});

describe('/admin/marketing/reviews: the review list', () => {
  const review = (k: number, status: string): Row => ({ id: `rv-${pad(k)}`, rating: 5, status, author_name: 'A', body: 'Good', deleted_at: null, submitted_at: at(k), reply: null });
  function seed(n: number) {
    db.seed('reviews', Array.from({ length: n }, (_, k) => review(k, 'approved')));
    db.seed('reputation_settings', []);
  }
  it('says it holds the newest 500 of its status', async () => {
    seed(600);
    expect(await render('reviews', { searchParams: Promise.resolve({ status: 'approved' }) })).toContain(part('adminCeiling.listShowsTheNewest', 500, 600));
    expect(await render('reviews', { searchParams: Promise.resolve({}) })).toContain(part('adminCeiling.listShowsTheNewest', 500, 600));
  });
  it('the control: a list that holds every review says nothing', async () => {
    seed(2);
    expect(await render('reviews', { searchParams: Promise.resolve({}) })).not.toContain(part('adminCeiling.listShowsTheNewest', 2, 2).slice(0, 30));
  });
});

describe('/admin/marketing/surveys/[id]: the response list', () => {
  function seed(n: number) {
    db.seed('surveys', [{ id: 'sv-1', name: 'NPS', slug: 'nps', type: 'nps', status: 'active', scale_min: 0, scale_max: 10, question: 'How likely?', deleted_at: null, created_at: at(0) }]);
    db.seed('survey_responses', Array.from({ length: n }, (_, k) => ({ id: `sr-${pad(k)}`, survey_id: 'sv-1', score: 9, comment: null, submitted_at: at(k) })));
  }
  it('says it holds the newest of every response', async () => {
    seed(250);
    const page = await render('surveys/[id]', { params: Promise.resolve({ id: 'sv-1' }) });
    expect(page).toContain(part('adminCeiling.listShowsTheNewest', 100, 250));
  });
  it('the control: a list that holds every response says nothing', async () => {
    seed(2);
    const page = await render('surveys/[id]', { params: Promise.resolve({ id: 'sv-1' }) });
    expect(page).not.toContain(part('adminCeiling.listShowsTheNewest', 2, 2).slice(0, 30));
  });
});

// Round 10 (review R9-PARTIAL-LISTS-THAT-DO-NOT-SAY-SO), two kinds.
//  1. Unbounded reads PostgREST answers with at most db-max-rows: the recurring
//     campaign list beside a Campaigns count, and the platform's Templates and
//     Brand rules cards, whose badges counted their lists.
//  2. Notes hidden past a summed ceiling, where the list is certainly part of a
//     set larger than the ceiling: they say so now, without a total.
describe('/admin/marketing/social/recurring: the campaign list', () => {
  const ad = (k: number): Row => ({
    id: `ra-${pad(k)}`, name: `Recurring ${k}`, status: 'paused', platforms: ['x'], body_variants: ['Hi'], occurrences: 0, max_occurrences: null,
    cadence: 'weekly', starts_at: at(k), ends_at: null, next_run_at: null, last_run_at: null, deleted_at: null, created_at: at(k), timezone: 'UTC',
  });
  it('says it holds the newest 1,000 of every campaign', async () => {
    db.seed('marketing_recurring_ads', Array.from({ length: 1100 }, (_, k) => ad(k)));
    db.seed('marketing_recurring_ad_runs', []);
    expect(await render('social/recurring')).toContain(part('adminCeiling.listShowsTheNewest', 1000, 1100));
  });
  it('the control: a list that holds every campaign says nothing', async () => {
    db.seed('marketing_recurring_ads', [ad(1), ad(2)]);
    db.seed('marketing_recurring_ad_runs', []);
    expect(await render('social/recurring')).not.toContain(part('adminCeiling.listShowsTheNewest', 2, 2).slice(0, 30));
  });
});

describe('/admin/marketing/platform: the Templates and Brand rules cards', () => {
  const template = (k: number): Row => ({ id: `tp-${pad(k)}`, name: `Template ${k}`, page_type: 'guide', status: 'active', description: null, instructions: 'Write it.', defaults: {}, is_default: false });
  const rule = (k: number): Row => ({ id: `br-${pad(k)}`, rule_key: `rule_${k}`, name: `Rule ${k}`, instructions: 'Say it.', value: {}, active: true });
  function seed(templates: number, rules: number) {
    db.seed('marketing_content_templates', Array.from({ length: templates }, (_, k) => template(k)));
    db.seed('marketing_brand_rules', Array.from({ length: rules }, (_, k) => rule(k)));
    for (const table of ['marketing_pages', 'marketing_generation_jobs', 'marketing_provider_syncs', 'marketing_provider_observations', 'marketing_embeddings']) db.seed(table, []);
  }
  /** The badge beside a card's heading. */
  const badge = (html: string, heading: string) => new RegExp(`<h3 class="font-semibold">${heading}</h3>.*?</div><span[^>]*>([^<]*)</span>`).exec(html)?.[1];
  async function renderHtml(): Promise<string> {
    const { default: Page } = await import('@/app/(app)/admin/marketing/platform/page');
    return renderServerPage(await (Page as () => Promise<React.ReactElement>)());
  }
  it('each badge counts every row past the 1,000 listed, and each list says it is part', async () => {
    seed(1001, 1002);
    const html = await renderHtml();
    expect(badge(html, m('adminMarketingPlatform.templates'))).toBe('1,001');
    expect(badge(html, m('adminMarketingPlatform.brandRules'))).toBe('1,002');
    expect(textOf(html)).toContain(part('adminCeiling.listShowsPart', 1000, 1001));
    expect(textOf(html)).toContain(part('adminCeiling.listShowsPart', 1000, 1002));
  });
  it('the control: lists that hold everything are counted the same and say nothing', async () => {
    seed(2, 3);
    const html = await renderHtml();
    expect(badge(html, m('adminMarketingPlatform.templates'))).toBe('2');
    expect(badge(html, m('adminMarketingPlatform.brandRules'))).toBe('3');
    expect(textOf(html)).not.toContain(part('adminCeiling.listShowsPart', 2, 2).slice(0, 20));
  });
});

// Round 11 (review R10-SEO-REGISTRY-COUNTS-ITS-UNBOUNDED-LIST): the SEO page
// registry's tab count and "N tracked" were the length of an unbounded list,
// the same shape as the platform's Templates and Brand rules badges.
describe('/admin/marketing/seo: the SEO page registry', () => {
  const seoPage = (k: number): Row => ({ id: `sp-${pad(k)}`, path: `/p/${pad(k)}`, title: null, meta_description: null, score: null, status: 'active', created_at: at(k), updated_at: at(k) });
  function seed(pages: number) {
    db.seed('marketing_seo_keywords', []);
    db.seed('marketing_seo_pages', Array.from({ length: pages }, (_, k) => seoPage(k)));
  }
  type Tab = { id: string; label: string; count?: number; panel: React.ReactNode };
  /** The tabs the page hands its (real) tab switcher, which shows only the first panel. */
  function tabsOf(node: unknown): Tab[] | undefined {
    if (!node || typeof node !== 'object') return undefined;
    if (Array.isArray(node)) return node.map(tabsOf).find(Boolean);
    const props = (node as { props?: { tabs?: Tab[]; children?: unknown } }).props;
    return props?.tabs ?? tabsOf(props?.children);
  }
  async function renderSeo() {
    const { default: Page } = await import('@/app/(app)/admin/marketing/seo/page');
    const tree = await (Page as () => Promise<React.ReactElement>)();
    const html = await renderServerPage(tree);
    const registry = tabsOf(tree)?.find((tab) => tab.id === 'registry');
    return { html, registry: registry ? textOf(await renderServerPage(registry.panel)) : '' };
  }
  /** The count beside a tab's label. */
  const tabCount = (html: string, label: string) => new RegExp(`${label}<span[^>]*>\\(([^)]*)\\)</span>`).exec(html)?.[1];

  it('the tab and "N tracked" count every page past the 1,000 listed, and the list says it is part', async () => {
    seed(1001);
    const { html, registry } = await renderSeo();
    expect(tabCount(html, 'SEO Page Registry')).toBe('1,001');
    expect(registry).toContain('1,001 tracked');
    expect(registry).toContain(part('adminCeiling.listShowsPart', 1000, 1001));
  });
  it('a registry count that FAILS, alone, is the read-error state', async () => {
    seed(3);
    let faulted = 0;
    h.db = withFaults(db, (table, calls) => {
      if (table !== 'marketing_seo_pages' || !head(calls)) return null;
      faulted += 1;
      return { message: 'marketing_seo_pages unavailable' };
    });
    const { html, registry } = await renderSeo();
    expect(faulted).toBe(1);
    expect(textOf(html)).toContain(m('seo.couldNotLoadSeoKeywords'));
    expect(registry).toBe('');
  });
  it('the control: a registry the list holds is counted the same and says nothing', async () => {
    seed(3);
    const { html, registry } = await renderSeo();
    expect(tabCount(html, 'SEO Page Registry')).toBe('3');
    expect(registry).toContain('3 tracked');
    expect(registry).not.toContain(part('adminCeiling.listShowsPart', 3, 3).slice(0, 20));
  });
});

describe('past a summed ceiling, a list that is certainly part of its set says so without a total', () => {
  const newest = (shown: number) => m('adminCeiling.listShowsTheNewestTotalNotShown', { shown: shown.toLocaleString() });
  it('/admin/marketing/reviews: the newest 500 of more than 25,000 reviews', async () => {
    db.seed('reviews', Array.from({ length: 25_001 }, (_, k) => ({ id: `rv-${pad(k)}`, rating: 5, status: 'approved', author_name: 'A', body: 'Good', deleted_at: null, submitted_at: at(k), reply: null })));
    db.seed('reputation_settings', []);
    const page = await render('reviews', { searchParams: Promise.resolve({}) });
    expect(page).toContain(m('adminCeiling.figuresNotShown', { n: '25,000' }).slice(0, 30));
    expect(page).toContain(newest(500));
    expect(await render('reviews', { searchParams: Promise.resolve({ status: 'approved' }) })).toContain(newest(500));
  });
  it('/admin/marketing/reviews, the control: a status past the ceiling whose list is not full says nothing', async () => {
    db.seed('reviews', Array.from({ length: 25_001 }, (_, k) => ({ id: `rv-${pad(k)}`, rating: 5, status: k < 3 ? 'pending' : 'approved', author_name: 'A', body: 'Good', deleted_at: null, submitted_at: at(k), reply: null })));
    db.seed('reputation_settings', []);
    expect(await render('reviews', { searchParams: Promise.resolve({ status: 'pending' }) })).not.toContain(newest(3).slice(0, 30));
  });
  it('/admin/marketing/competitive: the newest 500 of more than 25,000 backlinks', async () => {
    db.seed('competitors', []);
    db.seed('keyword_intel', []);
    db.seed('backlinks', Array.from({ length: 25_001 }, (_, k) => ({ id: `bl-${pad(k)}`, source_domain: `s${k}.example`, target_url: '/', authority: 10, status: 'active', created_at: at(k) })));
    expect(await render('competitive')).toContain(newest(500));
  });
  it('/admin/marketing/surveys/[id]: the newest 100 of more than 25,000 responses', async () => {
    db.seed('surveys', [{ id: 'sv-1', name: 'NPS', slug: 'nps', type: 'nps', status: 'active', scale_min: 0, scale_max: 10, question: 'How likely?', deleted_at: null, created_at: at(0) }]);
    db.seed('survey_responses', Array.from({ length: 25_001 }, (_, k) => ({ id: `sr-${pad(k)}`, survey_id: 'sv-1', score: 9, comment: null, submitted_at: at(k) })));
    expect(await render('surveys/[id]', { params: Promise.resolve({ id: 'sv-1' }) })).toContain(newest(100));
  });
  it('/admin/marketing/leads: 60 of more than 10,000 leads', async () => {
    db.seed('support_tickets', Array.from({ length: 10_001 }, (_, k) => ({
      id: `ld-${pad(k)}`, subject: `Lead ${k}`, description: 'Hello', requester_name: `Person ${k}`, requester_email: `p${k}@example.com`,
      status: 'open', created_at: at(k), family_id: null, tags: ['contact-form'],
    })));
    for (const table of ['families', 'subscriptions', 'family_members', 'profiles']) db.seed(table, []);
    expect(await render('leads')).toContain(m('adminCeiling.listShowsPartTotalNotShown', { shown: '60' }));
  });
  it('the control: below the ceiling each list names its total, not "the total is not shown"', async () => {
    db.seed('backlinks', Array.from({ length: 600 }, (_, k) => ({ id: `bl-${pad(k)}`, source_domain: `s${k}.example`, target_url: '/', authority: 10, status: 'active', created_at: at(k) })));
    db.seed('competitors', []);
    db.seed('keyword_intel', []);
    const page = await render('competitive');
    expect(page).toContain(part('adminCeiling.listShowsTheNewest', 500, 600));
    expect(page).not.toContain(newest(500));
  });
});
