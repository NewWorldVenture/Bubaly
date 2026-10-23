import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { createElement } from 'react';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderServerPage, statCardValue, textOf } from './helpers/render-server-page';

// Five admin marketing pages counted, summed or labelled from a list capped at
// 500 rows (or 200) and presented the result as the whole CRM (review
// R4-ADMIN-CAPPED-SUMS-CRM): Contacts read 500 past 500 sign-ups (every
// onboarded account holder files one), the pipeline and proposal totals left
// out every older deal and quote, a deal or quote whose contact was older than
// the newest 500 contacts lost its name, the review average and distribution
// described the newest 500 reviews, and the competitive tiles stopped at their
// lists. Each case seeds past the list's cap, and past PostgREST's 1,000-row
// response cap, and drives the real page.
const CAP = 1000;
const ROWS = 1300;
const CEILING = 25_000;
const UNAVAILABLE = SOURCE_MESSAGES['strategyMetrics.unavailable'];
const pad = (i: number) => String(i).padStart(6, '0');
/** Oldest first: row 0 is the oldest. */
const at = (i: number) => new Date(Date.UTC(2025, 0, 1) + i * 60_000).toISOString();

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => h.db,
  describeConfiguredServiceKey: () => null,
}));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
  getLocaleContext: async () => ({ locale: { code: 'en-US' } }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: ComponentProps<'a'>) => createElement('a', { href, ...props }, children),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }) }));
// The server actions behind the forms; none of them carries a number read here.
vi.mock('@/app/(app)/admin/marketing/crm/actions', () => ({
  saveContactAction: async () => {}, deleteContactAction: async () => {},
  saveDealAction: async () => {}, setDealStageAction: async () => {}, deleteDealAction: async () => {},
}));
vi.mock('@/app/(app)/admin/marketing/proposals/actions', () => ({
  saveQuoteAction: async () => {}, setQuoteStatusAction: async () => {}, deleteQuoteAction: async () => {},
}));
vi.mock('@/app/(app)/admin/marketing/reviews/actions', () => ({
  moderateReviewAction: async () => {}, replyToReviewAction: async () => {}, deleteReviewAction: async () => {},
  saveReputationSettingsAction: async () => {},
}));
vi.mock('@/app/(app)/admin/marketing/competitive/actions', () => ({
  saveCompetitorAction: async () => {}, deleteCompetitorAction: async () => {},
  saveKeywordAction: async () => {}, deleteKeywordAction: async () => {},
  saveBacklinkAction: async () => {}, deleteBacklinkAction: async () => {},
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

/** The figures a ceiling cost, as the page's PartialReadBanner names them, or null with no banner. */
function ceilingBanner(html: string): string[] | null {
  const start = html.indexOf('<div role="status"');
  if (start < 0) return null;
  const banner = html.slice(start, html.indexOf('</ul></div>', start));
  expect(textOf(banner)).toContain(translate(SOURCE_MESSAGES, 'adminCeiling.figuresNotShown', { n: CEILING.toLocaleString() }));
  return [...banner.matchAll(/<li>([^<]*)<\/li>/g)].map((m) => m[1]);
}

/**
 * 1,300 contacts, oldest first: the 300 OLDEST are customers at 300 companies
 * and 100 of them are also qualified; the 1,000 newest are leads with no company.
 */
function seedContacts() {
  db.seed('crm_contacts', Array.from({ length: ROWS }, (_, i) => ({
    id: `contact-${pad(i)}`, first_name: `First${i}`, last_name: `Last${i}`, email: `c${i}@example.com`, phone: null,
    company: i < 300 ? `Company ${i}` : null, lead_source: null, lead_status: 'new',
    lifecycle_stage: i < 200 ? 'customer' : i < 300 ? (i % 2 ? 'mql' : 'sql') : 'lead', created_at: at(i), updated_at: at(i),
  })));
}

describe('/admin/marketing/crm: the tiles are every contact', () => {
  async function render() {
    const { default: CrmPage } = await import('@/app/(app)/admin/marketing/crm/page');
    return renderServerPage(await CrmPage());
  }

  it('Contacts, Customers, Qualified and Companies count past the newest 500', async () => {
    seedContacts();
    const html = await render();
    expect(statCardValue(html, 'Contacts')).toBe('1300');
    expect(statCardValue(html, 'Customers')).toBe('200');
    expect(statCardValue(html, 'Qualified (M/SQL)')).toBe('100');
    expect(statCardValue(html, 'Companies')).toBe('300');
    expect(ceilingBanner(html)).toBeNull();
  });

  it('a count that fails is the read-error state, not zero', async () => {
    seedContacts();
    h.db = withFaults(db, (_table, calls) => (calls.some((c) => c.method === 'eq' && c.args[1] === 'customer') ? { message: 'count unavailable' } : null));
    expect(await render()).toContain(SOURCE_MESSAGES['crm.couldNotLoadCrmContacts']);
  });

  it('companies past the ceiling cost the Companies tile, not the list or the form', async () => {
    seedContacts();
    db.seed('crm_contacts', Array.from({ length: CEILING }, (_, i) => ({
      id: `contact-z-${pad(i)}`, first_name: null, last_name: null, email: `z${i}@example.com`, company: `Firm ${i}`,
      lead_status: 'new', lifecycle_stage: 'subscriber', created_at: '2024-01-01T00:00:00Z',
    })));
    const html = await render();
    expect(html).not.toContain(SOURCE_MESSAGES['crm.couldNotLoadCrmContacts']);
    expect(statCardValue(html, 'Companies')).toBe(UNAVAILABLE);
    expect(ceilingBanner(html)).toEqual(['Companies']);
    expect(statCardValue(html, 'Contacts')).toBe(String(ROWS + CEILING));
    expect(html).toContain(SOURCE_MESSAGES['adminMarketingCrm.addContact']);
    expect(html).toContain(`First${ROWS - 1} Last${ROWS - 1}`);
  });
});

/** 1,300 deals, oldest first: 300 lost, then 500 won at $100, then the newest 500 open leads at $10. */
function seedDeals() {
  seedContacts();
  db.seed('crm_deals', Array.from({ length: ROWS }, (_, i) => ({
    id: `deal-${pad(i)}`, name: `Deal ${i}`, amount_cents: i >= 800 ? 1_000 : 10_000,
    stage: i < 300 ? 'lost' : i < 800 ? 'won' : 'lead',
    // The newest deal's contact is the OLDEST contact, past the newest 500.
    contact_id: i === ROWS - 1 ? 'contact-000000' : null, close_date: null, created_at: at(i), updated_at: at(i),
  })));
}

describe('/admin/marketing/pipeline: the tiles are every deal, and a deal names its contact', () => {
  async function render() {
    const { default: PipelinePage } = await import('@/app/(app)/admin/marketing/pipeline/page');
    return renderServerPage(await PipelinePage());
  }

  it('Open pipeline, Won and Win rate add up past the newest 500 deals', async () => {
    seedDeals();
    const html = await render();
    expect(statCardValue(html, 'Open pipeline')).toBe('$5,000');
    expect(statCardValue(html, 'Won')).toBe('$50,000');
    // 500 won of 800 closed.
    expect(statCardValue(html, 'Win rate')).toBe('63%');
    expect(ceilingBanner(html)).toBeNull();
  });

  it('a listed deal whose contact is older than the newest 500 contacts names that contact', async () => {
    seedDeals();
    const html = await render();
    expect(html).toContain('<p class="text-xs text-muted">First0 Last0</p>');
  });

  it('a summed read that fails is the read-error state', async () => {
    seedDeals();
    h.db = withFaults(db, (_table, calls) => (calls.some((c) => c.method === 'select' && c.args[0] === 'id, stage, amount_cents') ? { message: 'deals unavailable' } : null));
    expect(await render()).toContain(SOURCE_MESSAGES['pipeline.couldNotLoadTheSales']);
  });

  it('a contact name read that fails is the read-error state, not "—"', async () => {
    seedDeals();
    h.db = withFaults(db, (table, calls) => (table === 'crm_contacts' && calls.some((c) => c.method === 'in') ? { message: 'contacts unavailable' } : null));
    expect(await render()).toContain(SOURCE_MESSAGES['pipeline.couldNotLoadTheSales']);
  });

  it('deals past the ceiling cost the four tiles, not the board or the form', async () => {
    seedDeals();
    db.seed('crm_deals', Array.from({ length: CEILING }, (_, i) => ({
      id: `deal-z-${pad(i)}`, name: `Old deal ${i}`, amount_cents: 1, stage: 'lost', contact_id: null, created_at: '2024-01-01T00:00:00Z',
    })));
    const html = await render();
    expect(html).not.toContain(SOURCE_MESSAGES['pipeline.couldNotLoadTheSales']);
    for (const label of ['Open pipeline', 'Weighted (expected)', 'Won', 'Win rate']) expect(statCardValue(html, label)).toBe(UNAVAILABLE);
    // The board's stage headers add up the same whole pipeline, so they go with the tiles.
    expect(ceilingBanner(html)).toEqual(['Open pipeline', 'Weighted (expected)', 'Won', 'Win rate', SOURCE_MESSAGES['adminMarketingPipeline.stageTotals']]);
    expect(html.split(`<span class="text-xs text-muted">${UNAVAILABLE}</span>`)).toHaveLength(6 + 1);
    expect(html).toContain(`Deal ${ROWS - 1}`);
    expect(html).toContain(SOURCE_MESSAGES['adminMarketingPipeline.addDeal']);
  });

  // Each column header counted and added up the newest 500 deals on the board,
  // so past 500 deals the open stages no longer added up to Open pipeline and
  // nothing said the board was part of the pipeline (review
  // R5-CRM-BOARD-AND-RANKING-FROM-CAPPED-LISTS).
  it('each stage header counts and adds up its whole stage, and the board says it lists the newest 500', async () => {
    seedDeals();
    const html = await render();
    const header = (label: string) => {
      const match = new RegExp(`>${label}</span><span class="text-xs text-muted">([^<]*)</span>`).exec(html);
      if (!match) throw new Error(`no "${label}" column on the board`);
      return match[1];
    };
    // The newest 500 deals on the board are all leads; the 500 won and 300 lost are older.
    expect(header('Lead')).toBe('500 · $5,000');
    expect(header('Won')).toBe('500 · $50,000');
    expect(header('Lost')).toBe('300 · $30,000');
    expect(html).toContain(translate(SOURCE_MESSAGES, 'adminMarketingPipeline.boardIsTheNewest', { n: '500' }));
  });

  it('the control: a board that holds the whole pipeline does not say it is part of it', async () => {
    seedContacts();
    db.seed('crm_deals', Array.from({ length: 20 }, (_, i) => ({
      id: `deal-${pad(i)}`, name: `Deal ${i}`, amount_cents: 1_000, stage: 'lead', contact_id: null, close_date: null, created_at: at(i), updated_at: at(i),
    })));
    const html = await render();
    expect(html).toContain('>Lead</span><span class="text-xs text-muted">20 · $200</span>');
    expect(html).not.toContain(translate(SOURCE_MESSAGES, 'adminMarketingPipeline.boardIsTheNewest', { n: '500' }));
  });
});

/** 1,300 quotes, oldest first: 800 accepted at $100, then the newest 500 sent at $10. */
function seedQuotes() {
  seedContacts();
  db.seed('crm_quotes', Array.from({ length: ROWS }, (_, i) => ({
    id: `quote-${pad(i)}`, title: `Quote ${i}`, amount_cents: i < 800 ? 10_000 : 1_000, status: i < 800 ? 'accepted' : 'sent',
    valid_until: null, contact_id: i === ROWS - 1 ? 'contact-000000' : null, created_at: at(i), updated_at: at(i),
  })));
}

describe('/admin/marketing/proposals: the tiles are every quote, and a quote names its contact', () => {
  async function render() {
    const { default: ProposalsPage } = await import('@/app/(app)/admin/marketing/proposals/page');
    return renderServerPage(await ProposalsPage());
  }

  it('Quotes, Outstanding, Accepted and Accept rate add up past the newest 500 quotes', async () => {
    seedQuotes();
    const html = await render();
    expect(statCardValue(html, 'Quotes')).toBe('1300');
    expect(statCardValue(html, 'Outstanding')).toBe('$5,000');
    expect(statCardValue(html, 'Accepted')).toBe('$80,000');
    expect(statCardValue(html, 'Accept rate')).toBe('100%');
    expect(ceilingBanner(html)).toBeNull();
  });

  it('a listed quote whose contact is older than the newest 500 contacts names that contact', async () => {
    seedQuotes();
    const html = await render();
    expect(html).toContain('<td class="py-2">First0 Last0</td>');
  });

  it('a summed read that fails is the read-error state', async () => {
    seedQuotes();
    h.db = withFaults(db, (_table, calls) => (calls.some((c) => c.method === 'select' && c.args[0] === 'id, status, amount_cents, valid_until') ? { message: 'quotes unavailable' } : null));
    expect(await render()).toContain(SOURCE_MESSAGES['proposals.couldNotLoadProposalsFrom']);
  });

  it('a quote count that fails is the read-error state, not zero', async () => {
    seedQuotes();
    h.db = withFaults(db, (table, calls) => (table === 'crm_quotes' && calls.some((c) => c.method === 'select' && (c.args[1] as { head?: boolean } | undefined)?.head) ? { message: 'count unavailable' } : null));
    expect(await render()).toContain(SOURCE_MESSAGES['proposals.couldNotLoadProposalsFrom']);
  });

  it('quotes past the ceiling cost the three summed tiles, not the count, the table or the form', async () => {
    seedQuotes();
    db.seed('crm_quotes', Array.from({ length: CEILING }, (_, i) => ({
      id: `quote-z-${pad(i)}`, title: `Old quote ${i}`, amount_cents: 1, status: 'declined', valid_until: null, contact_id: null, created_at: '2024-01-01T00:00:00Z',
    })));
    const html = await render();
    expect(html).not.toContain(SOURCE_MESSAGES['proposals.couldNotLoadProposalsFrom']);
    for (const label of ['Outstanding', 'Accepted', 'Accept rate']) expect(statCardValue(html, label)).toBe(UNAVAILABLE);
    expect(ceilingBanner(html)).toEqual(['Outstanding', 'Accepted', 'Accept rate']);
    // Quotes is an exact count, so the ceiling does not reach it.
    expect(statCardValue(html, 'Quotes')).toBe(String(ROWS + CEILING));
    expect(html).toContain(`Quote ${ROWS - 1}`);
    expect(html).toContain(SOURCE_MESSAGES['adminMarketingProposals.createQuote']);
  });
});

/** 1,300 reviews, oldest first: 200 pending 1-star, 600 rejected 1-star, then the newest 500 approved 5-star. */
function seedReviews() {
  db.seed('reputation_settings', [{ singleton: true }]);
  db.seed('reviews', Array.from({ length: ROWS }, (_, i) => ({
    id: `review-${pad(i)}`, rating: i < 800 ? 1 : 5, title: `Review ${i}`, body: null, author_name: `Author ${i}`, author_email: null,
    source: 'internal', status: i < 200 ? 'pending' : i < 800 ? 'rejected' : 'approved', reply: null, deleted_at: null, submitted_at: at(i),
  })));
}

describe('/admin/marketing/reviews: the rating is every review, and the moderation queue reaches the old ones', () => {
  async function render(status?: string) {
    const { default: ReviewsPage } = await import('@/app/(app)/admin/marketing/reviews/page');
    return renderServerPage(await ReviewsPage({ searchParams: Promise.resolve(status ? { status } : {}) }));
  }
  const ratingCard = (html: string) => {
    const start = html.indexOf(`text-muted">${SOURCE_MESSAGES['adminMarketingReviews.averageRating']}</p>`);
    expect(start).toBeGreaterThan(0);
    const end = html.indexOf(SOURCE_MESSAGES['adminMarketingReviews.publicReviewLinkAmpWall'].replace('&', '&amp;'), start);
    expect(end).toBeGreaterThan(start);
    return textOf(html.slice(html.lastIndexOf('<', start), end));
  };

  it('the average, the count and the distribution are every review, not the newest 500', async () => {
    seedReviews();
    const html = await render();
    // (500 × 5 + 800 × 1) / 1,300 is 2.5; the newest 500 alone are 5.
    expect(ratingCard(html)).toContain('Average rating 2.5 1300 reviews · 38% positive');
    expect(ratingCard(html)).toMatch(/5 500 4 0 3 0 2 0 1 800/);
    expect(ceilingBanner(html)).toBeNull();
  });

  it('the status counts are every review, and the pending filter lists the pending reviews past the newest 500', async () => {
    seedReviews();
    const all = await render();
    expect(textOf(all)).toContain('pending (200) approved (500) featured (0) rejected (600)');
    const pending = await render('pending');
    expect(pending).toContain('Review 199');
    expect(pending).not.toContain(SOURCE_MESSAGES['adminMarketingReviews.noReviewsHere']);
  });

  it('a summed read that fails is the read-error state', async () => {
    seedReviews();
    h.db = withFaults(db, (_table, calls) => (calls.some((c) => c.method === 'select' && c.args[0] === 'id, rating, status') ? { message: 'reviews unavailable' } : null));
    expect(await render()).toContain(SOURCE_MESSAGES['reviews.couldNotLoadReviewsFrom']);
  });

  it('reviews past the ceiling cost the rating and distribution, not the queue or the settings', async () => {
    seedReviews();
    db.seed('reviews', Array.from({ length: CEILING }, (_, i) => ({
      id: `review-z-${pad(i)}`, rating: 3, title: null, body: null, author_name: null, author_email: null, source: 'import',
      status: 'rejected', reply: null, deleted_at: null, submitted_at: '2024-01-01T00:00:00Z',
    })));
    const html = await render();
    expect(html).not.toContain(SOURCE_MESSAGES['reviews.couldNotLoadReviewsFrom']);
    expect(ratingCard(html)).toBe(`${SOURCE_MESSAGES['adminMarketingReviews.averageRating']} ${UNAVAILABLE} ${SOURCE_MESSAGES['adminMarketingReviews.distribution']} ${UNAVAILABLE}`);
    // The review count and the status filters' counts are hidden with them, and
    // the banner says so too (review R5-CEILING-POLISH).
    expect(ceilingBanner(html)).toEqual([
      SOURCE_MESSAGES['adminMarketingReviews.averageRating'], SOURCE_MESSAGES['adminMarketingReviews.distribution'],
      SOURCE_MESSAGES['adminMarketingReviews.reviewAndStatusCounts'],
    ]);
    expect(textOf(html)).toContain('pending approved featured rejected');
    expect(html).toContain(`Review ${ROWS - 1}`);
    expect(html).toContain(SOURCE_MESSAGES['adminMarketingReviews.saveSettings']);
  });
});

/** 300 competitors and 1,300 keywords; 1,300 backlinks, oldest first: 800 active at authority 90, then the newest 500 lost at 10. */
function seedCompetitive() {
  db.seed('competitors', Array.from({ length: 300 }, (_, i) => ({ id: `comp-${pad(i)}`, name: `Rival ${i}`, domain: null, ranking: i + 1, created_at: at(i) })));
  db.seed('keyword_intel', Array.from({ length: ROWS }, (_, i) => ({ id: `kw-${pad(i)}`, keyword: `keyword ${i}`, search_volume: i, difficulty: 10, our_rank: null, created_at: at(i) })));
  db.seed('backlinks', Array.from({ length: ROWS }, (_, i) => ({
    id: `link-${pad(i)}`, source_domain: `site${i}.example`, target_url: null, authority: i < 800 ? 90 : 10, status: i < 800 ? 'active' : 'lost', created_at: at(i),
  })));
}

describe('/admin/marketing/competitive: the tiles are everything tracked', () => {
  async function render() {
    const { default: CompetitivePage } = await import('@/app/(app)/admin/marketing/competitive/page');
    return renderServerPage(await CompetitivePage());
  }

  it('Competitors, Keywords tracked, Active backlinks and Avg authority count past their lists', async () => {
    seedCompetitive();
    const html = await render();
    expect(statCardValue(html, 'Competitors')).toBe('300');
    expect(statCardValue(html, 'Keywords tracked')).toBe('1300');
    expect(statCardValue(html, 'Active backlinks')).toBe('800');
    // (800 × 90 + 500 × 10) / 1,300 is 59; the newest 500 alone are 10.
    expect(statCardValue(html, 'Avg authority')).toBe('59');
    expect(ceilingBanner(html)).toBeNull();
  });

  it('a count that fails is the read-error state', async () => {
    seedCompetitive();
    h.db = withFaults(db, (table, calls) => (table === 'keyword_intel' && calls.some((c) => c.method === 'select' && (c.args[1] as { head?: boolean } | undefined)?.head) ? { message: 'count unavailable' } : null));
    expect(await render()).toContain(SOURCE_MESSAGES['competitive.couldNotLoadCompetitiveIntelligence']);
  });

  it('backlinks past the ceiling cost their two tiles, not the lists or the forms', async () => {
    seedCompetitive();
    db.seed('backlinks', Array.from({ length: CEILING }, (_, i) => ({
      id: `link-z-${pad(i)}`, source_domain: `old${i}.example`, target_url: null, authority: 1, status: 'lost', created_at: '2024-01-01T00:00:00Z',
    })));
    const html = await render();
    expect(html).not.toContain(SOURCE_MESSAGES['competitive.couldNotLoadCompetitiveIntelligence']);
    expect(statCardValue(html, 'Active backlinks')).toBe(UNAVAILABLE);
    expect(statCardValue(html, 'Avg authority')).toBe(UNAVAILABLE);
    expect(ceilingBanner(html)).toEqual(['Active backlinks', 'Avg authority']);
    expect(statCardValue(html, 'Keywords tracked')).toBe('1300');
    expect(html).toContain(`site${ROWS - 1}.example`);
    expect(html).toContain(SOURCE_MESSAGES['adminMarketingCompetitive.addBacklink']);
  });

  // The opportunity table ranked an UNORDERED read of 500 keywords, so past
  // 500 the best opportunities could be missing from it (review
  // R5-CRM-BOARD-AND-RANKING-FROM-CAPPED-LISTS). It ranks every keyword now.
  const keywordRow = (i: number) => `<td class="py-2 font-medium">keyword ${i}</td>`;

  it('the opportunity table ranks every keyword and lists the best 500, best first', async () => {
    seedCompetitive();
    const html = await render();
    // Unranked keywords, so the opportunity grows with the volume, which is the
    // row number: the best are the newest, and the first 500 inserted the worst.
    const listed = [...html.matchAll(/<td class="py-2 font-medium">keyword (\d+)<\/td>/g)].map((m) => Number(m[1]));
    expect(listed).toHaveLength(500);
    expect(listed[0]).toBe(ROWS - 50);
    expect(listed).toContain(ROWS - 1);
    expect(listed.every((i) => i >= 750)).toBe(true);
    expect(html).not.toContain(keywordRow(0));
    expect(ceilingBanner(html)).toBeNull();
  });

  it('keywords past the ceiling cost the ranking, which says it is not shown; the count and the form stay', async () => {
    seedCompetitive();
    db.seed('keyword_intel', Array.from({ length: CEILING }, (_, i) => ({ id: `kw-z-${pad(i)}`, keyword: `old ${i}`, search_volume: 1, difficulty: 1, our_rank: 1, created_at: '2024-01-01T00:00:00Z' })));
    const html = await render();
    expect(html).not.toContain(SOURCE_MESSAGES['competitive.couldNotLoadCompetitiveIntelligence']);
    expect(ceilingBanner(html)).toEqual([SOURCE_MESSAGES['adminMarketingCompetitive.keywordIntelligence']]);
    expect(html).not.toContain(keywordRow(ROWS - 1));
    expect(html).toContain(`<p class="py-3 text-center text-sm text-muted">${UNAVAILABLE}</p>`);
    expect(statCardValue(html, 'Keywords tracked')).toBe(String(ROWS + CEILING));
    expect(html).toContain(SOURCE_MESSAGES['adminMarketingCompetitive.addKeyword']);
  });

  it('a keyword read that FAILS is still the read-error state', async () => {
    seedCompetitive();
    h.db = withFaults(db, (table, calls) => (table === 'keyword_intel' && calls.some((c) => c.method === 'select' && c.args[0] === '*') ? { message: 'keywords unavailable' } : null));
    expect(await render()).toContain(SOURCE_MESSAGES['competitive.couldNotLoadCompetitiveIntelligence']);
  });
});
