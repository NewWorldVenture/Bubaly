import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { createElement } from 'react';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderServerPage, statCardValue, textOf } from './helpers/render-server-page';

// Admin tiles that counted, summed or labelled from a read PostgREST answers
// with at most `db-max-rows` (1,000) and no error — or from a list deliberately
// limited to 100 — and presented the result as the whole platform (review
// R3-ADMIN-CAPPED-SUMS). Each case seeds past the cap and drives the real page.
const CAP = 1000;
const ROWS = 1300;
const pad = (i: number) => String(i).padStart(6, '0');
const minutesAgo = (n: number) => new Date(Date.UTC(2026, 9, 22, 11, 0) - n * 60_000).toISOString();

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
// Server actions behind the controls; none of them carries a number read here.
vi.mock('@/app/(app)/admin/marketing/loyalty/actions', () => ({
  saveLoyaltySettingsAction: async () => {}, awardPointsAction: async () => {},
  saveRewardAction: async () => ({ ok: true }), deleteRewardAction: async () => ({ ok: true }),
  fulfillRedemptionAction: async () => ({ ok: true }), cancelRedemptionAction: async () => ({ ok: true }),
}));
vi.mock('@/app/(app)/admin/marketing/surveys/actions', () => ({
  createSurveyAction: async () => {}, setSurveyStatusAction: async () => ({ ok: true }), deleteSurveyAction: async () => ({ ok: true }),
}));
vi.mock('@/components/admin/ticket-status-control', () => ({ TicketStatusControl: () => null }));
vi.mock('@/components/admin/new-ticket-button', () => ({ NewTicketButton: () => null }));
vi.mock('@/components/admin/ticket-row-actions', () => ({ TicketRowActions: () => null }));

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

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The ceiling every summed read here pages to. */
const CEILING = 25_000;
const UNAVAILABLE = SOURCE_MESSAGES['strategyMetrics.unavailable'];
/**
 * The figures a ceiling cost, as the page's PartialReadBanner names them (its
 * title checked, then one item per figure, in order), or null with no banner.
 */
function ceilingBanner(html: string): string[] | null {
  const at = html.indexOf('<div role="status"');
  if (at < 0) return null;
  const banner = html.slice(at, html.indexOf('</ul></div>', at));
  expect(textOf(banner)).toContain(translate(SOURCE_MESSAGES, 'adminCeiling.figuresNotShown', { n: CEILING.toLocaleString() }));
  return [...banner.matchAll(/<li>([^<]*)<\/li>/g)].map((m) => m[1]);
}

describe('the fake is the server it stands in for', () => {
  it('the control: an unbounded read stops at 1,000 rows and says nothing', async () => {
    db.seed('support_tickets', Array.from({ length: ROWS }, (_, i) => ({ id: `tkt-${pad(i)}`, status: 'open' })));
    const { data, error } = await db.from('support_tickets').select('*');
    expect(error).toBeNull();
    expect(data).toHaveLength(CAP);
  });
});

describe('/admin/marketing/loyalty: the tiles are the whole program, and every row names its family', () => {
  /** The value a loyalty tile renders under `label`. */
  const tile = (html: string, label: string) => {
    const match = new RegExp(`text-muted">${escapeRe(label)}</p><p class="mt-1 text-3xl font-bold leading-none">([^<]*)</p>`).exec(html);
    if (!match) throw new Error(`the "${label}" tile is not on the page`);
    return match[1];
  };

  function seedProgram() {
    // 1,000 families with no account come back first from an unordered read;
    // the 1,300 members are the 1,300 families after them.
    db.seed('families', [
      ...Array.from({ length: CAP }, (_, i) => ({ id: `fam-a-${pad(i)}`, name: `Bystander ${i}` })),
      ...Array.from({ length: ROWS }, (_, i) => ({ id: `fam-m-${pad(i)}`, name: `Member family ${i}` })),
    ]);
    db.seed('loyalty_settings', [{ singleton: true, enabled: true, tier_silver_at: 500, tier_gold_at: 2000 }]);
    db.seed('loyalty_rewards', []);
    db.seed('loyalty_accounts', Array.from({ length: ROWS }, (_, i) => ({
      id: `acct-${pad(i)}`, family_id: `fam-m-${pad(i)}`, points_balance: 10, lifetime_points: i, tier: 'bronze',
    })));
    // The newest 100 redemptions were fulfilled; the 1,200 older ones wait.
    db.seed('loyalty_redemptions', Array.from({ length: ROWS }, (_, i) => ({
      id: `red-${pad(i)}`, family_id: `fam-m-${pad(i)}`, reward_id: null, reward_name: 'Sticker pack', cost_points: 5,
      status: i >= ROWS - 100 ? 'fulfilled' : 'pending', code: null, notes: null, created_at: minutesAgo(ROWS - i),
    })));
  }

  async function render(): Promise<string> {
    const { default: LoyaltyPage } = await import('@/app/(app)/admin/marketing/loyalty/page');
    return renderServerPage(await LoyaltyPage());
  }

  it('Members, Points outstanding and Pending redemptions count every account and redemption, not the listed hundred', async () => {
    seedProgram();
    const html = await render();
    expect(tile(html, SOURCE_MESSAGES['adminMarketingLoyalty.members'])).toBe(String(ROWS));
    expect(tile(html, SOURCE_MESSAGES['adminMarketingLoyalty.pointsOutstanding'])).toBe((ROWS * 10).toLocaleString());
    expect(tile(html, SOURCE_MESSAGES['adminMarketingLoyalty.pendingRedemptions'])).toBe(String(ROWS - 100));
  });

  it('a member or a redemption from a family past the first thousand families names that family', async () => {
    seedProgram();
    const html = await render();
    // The top member by lifetime points, and the newest redemption.
    expect(html).toContain(`>Member family ${ROWS - 1}</span>`);
    expect(textOf(html)).toContain(`Member family ${ROWS - 1}`);
    expect(html).not.toContain('Unknown family');
  });

  it('a family name read that fails is the read-error state, not "Unknown family"', async () => {
    seedProgram();
    h.db = withFaults(db, (table, calls) => (table === 'families' && calls.some((c) => c.method === 'in') ? { message: 'families unavailable' } : null));
    const html = await render();
    expect(html).toContain(SOURCE_MESSAGES['loyalty.couldNotLoadLoyaltyData']);
    expect(html).not.toContain('Unknown family');
  });

  // Reaching the ceiling used to turn the whole page into the read-error
  // state, and with it the reward editor, the redemption queue, the award form
  // and the program settings (review R4-CEILING-LOCKS-WORK-PAGES). It costs
  // the one tile now, which says so rather than showing part of the balance.
  it('a balance read that reaches its ceiling costs the Points outstanding tile, not the program', async () => {
    seedProgram();
    db.seed('loyalty_accounts', Array.from({ length: CEILING - ROWS + 1 }, (_, i) => ({
      id: `acct-z-${pad(i)}`, family_id: 'fam-m-000000', points_balance: 1, lifetime_points: 0, tier: 'bronze',
    })));
    const html = await render();
    expect(html).not.toContain(SOURCE_MESSAGES['loyalty.couldNotLoadLoyaltyData']);
    expect(tile(html, SOURCE_MESSAGES['adminMarketingLoyalty.pointsOutstanding'])).toBe(UNAVAILABLE);
    expect(ceilingBanner(html)).toEqual([SOURCE_MESSAGES['adminMarketingLoyalty.pointsOutstanding']]);
    // Every other tile, the queue and the forms are still the program's.
    expect(tile(html, SOURCE_MESSAGES['adminMarketingLoyalty.members'])).toBe(String(CEILING + 1));
    expect(tile(html, SOURCE_MESSAGES['adminMarketingLoyalty.pendingRedemptions'])).toBe(String(ROWS - 100));
    expect(textOf(html)).toContain(`Member family ${ROWS - 1}`);
    expect(html).toContain(SOURCE_MESSAGES['adminMarketingLoyalty.awardAdjustPoints']);
    expect(html).toContain(SOURCE_MESSAGES['adminMarketingLoyalty.saveSettings']);
  });

  it('a balance read that FAILS is still the read-error state', async () => {
    seedProgram();
    h.db = withFaults(db, (_table, calls) => (calls.some((c) => c.method === 'select' && c.args[0] === 'id, points_balance') ? { message: 'balances unavailable' } : null));
    const html = await render();
    expect(html).toContain(SOURCE_MESSAGES['loyalty.couldNotLoadLoyaltyData']);
  });

  it('the control: under the ceiling no banner is shown', async () => {
    seedProgram();
    const html = await render();
    expect(ceilingBanner(html)).toBeNull();
  });
});

describe('/admin/support: the status tiles count every ticket', () => {
  it('Open and Resolved see the tickets past the newest thousand', async () => {
    // The 200 oldest tickets are resolved; the 1,100 newest are open.
    db.seed('support_tickets', Array.from({ length: ROWS }, (_, i) => ({
      id: `tkt-${pad(i)}`, subject: `Ticket ${i}`, requester_name: null, requester_email: `t${i}@example.com`, description: null,
      category: 'general', tags: ['contact-form'], status: i < 200 ? 'resolved' : 'open', created_at: minutesAgo(ROWS - i), updated_at: minutesAgo(ROWS - i),
    })));
    const { default: AdminSupportPage } = await import('@/app/(app)/admin/support/page');
    const html = await renderServerPage(await AdminSupportPage({ searchParams: Promise.resolve({}) }));
    expect(statCardValue(html, SOURCE_MESSAGES['adminSupport.open'])).toBe('1,100');
    expect(statCardValue(html, SOURCE_MESSAGES['adminSupport.resolved'])).toBe('200');
    expect(statCardValue(html, SOURCE_MESSAGES['adminSupport.closed'])).toBe('0');
  });

  it('a count that fails is the read-error state, not zero', async () => {
    db.seed('support_tickets', [{ id: 'tkt-1', subject: 'One', requester_email: 'a@example.com', category: 'general', tags: [], status: 'open', created_at: minutesAgo(1) }]);
    h.db = withFaults(db, (_table, calls) => (calls.some((c) => c.method === 'eq' && c.args[1] === 'resolved') ? { message: 'count unavailable' } : null));
    const { default: AdminSupportPage } = await import('@/app/(app)/admin/support/page');
    const html = await renderServerPage(await AdminSupportPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain(SOURCE_MESSAGES['support.couldNotLoadSupportTickets']);
  });
});

describe('/admin/support-tickets: the overview, the donut and the categories count every ticket', () => {
  /** The value an overview tile renders above `label`. */
  const overview = (html: string, label: string) => {
    const match = new RegExp(`leading-none">([^<]*)</p><p class="mt-0.5 text-\\[11px\\] text-muted">${escapeRe(label)}</p>`).exec(html);
    if (!match) throw new Error(`the "${label}" overview tile is not on the page`);
    return match[1];
  };

  function seedQueue() {
    // The 300 least recently updated tickets are closed billing tickets.
    db.seed('support_tickets', Array.from({ length: ROWS }, (_, i) => ({
      id: `tkt-${pad(i)}`, ticket_number: `T-${pad(i)}`, subject: `Ticket ${i}`, description: null,
      category: i < 300 ? 'billing' : 'technical', priority: 'medium', status: i < 300 ? 'closed' : 'open',
      requester_name: null, requester_email: `t${i}@example.com`, assigned_agent_id: null, assigned_agent_name: null,
      created_at: minutesAgo(ROWS - i), updated_at: minutesAgo(ROWS - i),
    })));
  }

  async function render(): Promise<string> {
    const { default: SupportTicketsPage } = await import('@/app/(app)/admin/support-tickets/page');
    return renderServerPage(await SupportTicketsPage({ searchParams: Promise.resolve({}) }));
  }

  it('Total, Open and Closed are the whole queue', async () => {
    seedQueue();
    const html = await render();
    expect(overview(html, SOURCE_MESSAGES['adminSupportTickets.total'])).toBe('1,300');
    expect(overview(html, SOURCE_MESSAGES['adminSupportTickets.open'])).toBe('1,000');
    expect(overview(html, SOURCE_MESSAGES['adminSupportTickets.closed'])).toBe('300');
  });

  it('Top Categories counts the billing tickets the newest thousand left out', async () => {
    seedQueue();
    const html = await render();
    expect(html).toContain('<span class="text-muted">Technical</span><span class="font-semibold">1000</span>');
    expect(html).toContain('<span class="text-muted">Billing</span><span class="font-semibold">300</span>');
  });

  it('a category tally that fails is the read-error state', async () => {
    seedQueue();
    h.db = withFaults(db, (_table, calls) => (calls.some((c) => c.method === 'select' && c.args[0] === 'id, category') ? { message: 'tally unavailable' } : null));
    const html = await render();
    expect(html).toContain(SOURCE_MESSAGES['supportTickets.couldNotLoadSupportTickets']);
  });

  // At 25,001 tickets the tally reached its ceiling and the page returned the
  // read-error state: the queue, its filters, the row actions and the export
  // went with it (review R4-CEILING-LOCKS-WORK-PAGES).
  it('a category tally that reaches its ceiling costs Top Categories, not the queue', async () => {
    seedQueue();
    db.seed('support_tickets', Array.from({ length: CEILING - ROWS + 1 }, (_, i) => ({
      id: `tkt-z-${pad(i)}`, ticket_number: `Z-${pad(i)}`, subject: `Old ticket ${i}`, description: null,
      category: 'general', priority: 'low', status: 'closed', requester_name: null, requester_email: `z${i}@example.com`,
      assigned_agent_id: null, assigned_agent_name: null, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
    })));
    const html = await render();
    expect(html).not.toContain(SOURCE_MESSAGES['supportTickets.couldNotLoadSupportTickets']);
    expect(ceilingBanner(html)).toEqual([SOURCE_MESSAGES['adminSupportTickets.topCategories']]);
    const card = html.slice(html.lastIndexOf(SOURCE_MESSAGES['adminSupportTickets.topCategories']));
    expect(card.slice(0, card.indexOf(SOURCE_MESSAGES['adminSupportTickets.viewAllCategories']))).toContain(`<p class="text-sm text-muted">${UNAVAILABLE}</p>`);
    expect(html).not.toContain('<span class="text-muted">Technical</span>');
    // The queue is still there: the counts, the newest ticket and the export.
    expect(overview(html, SOURCE_MESSAGES['adminSupportTickets.total'])).toBe((CEILING + 1).toLocaleString());
    expect(html).toContain(`T-${pad(ROWS - 1)}`);
    expect(html).toContain('href="/api/admin/support-tickets/export"');
  });

  it('the control: under the ceiling no banner is shown', async () => {
    seedQueue();
    const html = await render();
    expect(ceilingBanner(html)).toBeNull();
  });
});

describe('/admin/marketing/surveys: every response is scored', () => {
  function seedSurveys() {
    db.seed('surveys', [
      { id: 'srv-a', name: 'Onboarding', type: 'nps', status: 'active', slug: 'onboarding', question: 'Recommend us?', scale_min: 0, scale_max: 10, deleted_at: null, created_at: '2026-09-01T00:00:00Z' },
      { id: 'srv-b', name: 'Renewal', type: 'nps', status: 'active', slug: 'renewal', question: 'Recommend us?', scale_min: 0, scale_max: 10, deleted_at: null, created_at: '2026-09-02T00:00:00Z' },
    ]);
    // 1,000 promoters for the first survey come back first; the second
    // survey's 300 detractors are past them.
    db.seed('survey_responses', [
      ...Array.from({ length: CAP }, (_, i) => ({ id: `resp-a-${pad(i)}`, survey_id: 'srv-a', score: 10, comment: null, respondent_email: null, submitted_at: minutesAgo(i) })),
      ...Array.from({ length: 300 }, (_, i) => ({ id: `resp-b-${pad(i)}`, survey_id: 'srv-b', score: 0, comment: null, respondent_email: null, submitted_at: minutesAgo(i) })),
    ]);
  }

  it('the list scores a survey whose responses are past the first thousand of all surveys', async () => {
    seedSurveys();
    const { default: SurveysPage } = await import('@/app/(app)/admin/marketing/surveys/page');
    const html = await renderServerPage(await SurveysPage());
    const text = textOf(html);
    expect(text).toContain('Renewal NPS · 300 responses');
    expect(text).toContain('-100 NPS · 0% promoters · 100% detractors');
    expect(text).toContain('Onboarding NPS · 1000 responses');
  });

  it('a response read that fails is the read-error state', async () => {
    seedSurveys();
    h.db = withFaults(db, (table) => (table === 'survey_responses' ? { message: 'responses unavailable' } : null));
    const { default: SurveysPage } = await import('@/app/(app)/admin/marketing/surveys/page');
    const html = await renderServerPage(await SurveysPage());
    expect(html).toContain(SOURCE_MESSAGES['surveys.couldNotLoadSurveyData']);
  });

  // Every response in the table was read, a deleted survey's included, so a
  // deleted survey answered 25,001 times put the list and the form to create
  // a survey behind the read-error state (review R4-CEILING-LOCKS-WORK-PAGES).
  it('a deleted survey\'s responses are not read, so they cannot reach the ceiling', async () => {
    seedSurveys();
    db.seed('surveys', [{ id: 'srv-gone', name: 'Retired', type: 'nps', status: 'closed', slug: 'retired', question: 'Recommend us?', scale_min: 0, scale_max: 10, deleted_at: '2026-10-01T00:00:00Z', created_at: '2026-08-01T00:00:00Z' }]);
    db.seed('survey_responses', Array.from({ length: CEILING + 1 }, (_, i) => ({
      id: `resp-gone-${pad(i)}`, survey_id: 'srv-gone', score: 5, comment: null, respondent_email: null, submitted_at: minutesAgo(i),
    })));
    const { default: SurveysPage } = await import('@/app/(app)/admin/marketing/surveys/page');
    const html = await renderServerPage(await SurveysPage());
    const text = textOf(html);
    expect(html).not.toContain(SOURCE_MESSAGES['surveys.couldNotLoadSurveyData']);
    expect(ceilingBanner(html)).toBeNull();
    expect(text).toContain('Renewal NPS · 300 responses');
    expect(text).toContain('Onboarding NPS · 1000 responses');
    expect(text).not.toContain('Retired');
    expect(html).toContain(SOURCE_MESSAGES['adminMarketingSurveys.createSurvey']);
  });

  it('a batch of live surveys past the ceiling costs those surveys\' scores, not the list or the form', async () => {
    // A hundred surveys a request, newest first: the oldest survey is alone
    // in the second batch, and it alone is answered more often than the ceiling.
    db.seed('surveys', [
      ...Array.from({ length: 100 }, (_, i) => ({
        id: `srv-${pad(i)}`, name: `Survey ${i}`, type: 'nps', status: 'active', slug: `survey-${i}`, question: 'Recommend us?',
        scale_min: 0, scale_max: 10, deleted_at: null, created_at: new Date(Date.UTC(2026, 8, 2) + i * 60_000).toISOString(),
      })),
      { id: 'srv-legacy', name: 'Legacy', type: 'nps', status: 'active', slug: 'legacy', question: 'Recommend us?', scale_min: 0, scale_max: 10, deleted_at: null, created_at: '2026-01-01T00:00:00Z' },
    ]);
    db.seed('survey_responses', [
      ...Array.from({ length: 100 }, (_, i) => ({ id: `resp-${pad(i)}`, survey_id: `srv-${pad(i)}`, score: 10, comment: null, respondent_email: null, submitted_at: minutesAgo(i) })),
      ...Array.from({ length: CEILING + 1 }, (_, i) => ({ id: `resp-l-${pad(i)}`, survey_id: 'srv-legacy', score: 0, comment: null, respondent_email: null, submitted_at: minutesAgo(i) })),
    ]);
    const { default: SurveysPage } = await import('@/app/(app)/admin/marketing/surveys/page');
    const html = await renderServerPage(await SurveysPage());
    const text = textOf(html);
    expect(html).not.toContain(SOURCE_MESSAGES['surveys.couldNotLoadSurveyData']);
    expect(ceilingBanner(html)).toEqual(['Legacy']);
    expect(text).toContain(`Legacy NPS active ${UNAVAILABLE} NPS`);
    expect(text).toContain('Survey 99 NPS · 1 response active 100 NPS · 100% promoters · 0% detractors');
    expect(html).toContain(SOURCE_MESSAGES['adminMarketingSurveys.createSurvey']);
  });

  // One survey answered past the ceiling cost the scores of the up to 99 other
  // surveys read in its batch, and the banner named them all as if each were
  // past it (review R5-CEILING-POLISH). The batch is read again a survey at a
  // time; and two surveys of one name are one line of the banner.
  it('a survey answered past the ceiling costs its own score, not its batch\'s; a name is named once', async () => {
    db.seed('surveys', Array.from({ length: 100 }, (_, i) => ({
      id: `srv-${pad(i)}`, name: i < 2 ? 'Legacy' : `Survey ${i}`, type: 'nps', status: 'active', slug: `survey-${i}`, question: 'Recommend us?',
      scale_min: 0, scale_max: 10, deleted_at: null, created_at: new Date(Date.UTC(2026, 8, 2) + i * 60_000).toISOString(),
    })));
    db.seed('survey_responses', [
      ...Array.from({ length: 100 }, (_, i) => ({ id: `resp-${pad(i)}`, survey_id: `srv-${pad(i)}`, score: 10, comment: null, respondent_email: null, submitted_at: minutesAgo(i) })),
      // The two surveys named Legacy are each answered past the ceiling.
      ...[0, 1].flatMap((s) => Array.from({ length: CEILING + 1 }, (_, i) => ({
        id: `resp-l${s}-${pad(i)}`, survey_id: `srv-${pad(s)}`, score: 0, comment: null, respondent_email: null, submitted_at: minutesAgo(i),
      }))),
    ]);
    const { default: SurveysPage } = await import('@/app/(app)/admin/marketing/surveys/page');
    const html = await renderServerPage(await SurveysPage());
    const text = textOf(html);
    expect(html).not.toContain(SOURCE_MESSAGES['surveys.couldNotLoadSurveyData']);
    expect(ceilingBanner(html)).toEqual(['Legacy']);
    expect(text.split(`Legacy NPS active ${UNAVAILABLE} NPS`)).toHaveLength(3);
    // The 98 other surveys in the batch are scored.
    for (const i of [2, 50, 99]) expect(text).toContain(`Survey ${i} NPS · 1 response active 100 NPS · 100% promoters · 0% detractors`);
  });

  it('a survey read that FAILS on the retry is still the read-error state', async () => {
    db.seed('surveys', Array.from({ length: 2 }, (_, i) => ({
      id: `srv-${pad(i)}`, name: `Survey ${i}`, type: 'nps', status: 'active', slug: `survey-${i}`, question: 'Recommend us?',
      scale_min: 0, scale_max: 10, deleted_at: null, created_at: new Date(Date.UTC(2026, 8, 2) + i * 60_000).toISOString(),
    })));
    db.seed('survey_responses', Array.from({ length: CEILING + 1 }, (_, i) => ({ id: `resp-${pad(i)}`, survey_id: 'srv-000000', score: 0, comment: null, respondent_email: null, submitted_at: minutesAgo(i) })));
    // The batch read answers; a single survey's read does not.
    h.db = withFaults(db, (table, calls) => (table === 'survey_responses'
      && calls.some((c) => c.method === 'in' && (c.args[1] as unknown[]).length === 1 && (c.args[1] as unknown[])[0] === 'srv-000001')
      ? { message: 'responses unavailable' } : null));
    const { default: SurveysPage } = await import('@/app/(app)/admin/marketing/surveys/page');
    expect(await renderServerPage(await SurveysPage())).toContain(SOURCE_MESSAGES['surveys.couldNotLoadSurveyData']);
  });

  it('the survey page scores every response, not its newest thousand', async () => {
    db.seed('surveys', [{ id: 'srv-a', name: 'Onboarding', type: 'nps', status: 'active', slug: 'onboarding', question: 'Recommend us?', scale_min: 0, scale_max: 10, deleted_at: null }]);
    // The 300 OLDEST responses are the detractors.
    db.seed('survey_responses', Array.from({ length: ROWS }, (_, i) => ({
      id: `resp-${pad(i)}`, survey_id: 'srv-a', score: i < 300 ? 0 : 10, comment: null, respondent_email: null, submitted_at: minutesAgo(ROWS - i),
    })));
    const { default: SurveyDetailPage } = await import('@/app/(app)/admin/marketing/surveys/[id]/page');
    const html = await renderServerPage(await SurveyDetailPage({ params: Promise.resolve({ id: 'srv-a' }) }));
    const text = textOf(html);
    // 1,000 promoters and 300 detractors of 1,300: NPS 54. The newest thousand alone is 100.
    expect(text).toContain('NPS 54 1300 responses · 77% promoters · 23% detractors');
    // The list is the newest hundred.
    expect(html.split('rounded-lg bg-elevated text-sm font-bold').length - 1).toBe(100);
  });

  // Past the ceiling the page was the read-error state, and the controls to
  // close or delete the survey and its newest responses went with it (review
  // R4-CEILING-LOCKS-WORK-PAGES).
  it('a survey answered past the ceiling costs its score and distribution, not the page', async () => {
    db.seed('surveys', [{ id: 'srv-a', name: 'Onboarding', type: 'nps', status: 'active', slug: 'onboarding', question: 'Recommend us?', scale_min: 0, scale_max: 10, deleted_at: null }]);
    db.seed('survey_responses', Array.from({ length: CEILING + 1 }, (_, i) => ({
      id: `resp-${pad(i)}`, survey_id: 'srv-a', score: 10, comment: i === CEILING ? 'The newest one' : null, respondent_email: null, submitted_at: minutesAgo(CEILING - i),
    })));
    const { default: SurveyDetailPage } = await import('@/app/(app)/admin/marketing/surveys/[id]/page');
    const html = await renderServerPage(await SurveyDetailPage({ params: Promise.resolve({ id: 'srv-a' }) }));
    const text = textOf(html);
    expect(html).not.toContain(SOURCE_MESSAGES['surveys.couldNotLoadThisSurvey']);
    expect(ceilingBanner(html)).toEqual(['NPS', SOURCE_MESSAGES['adminMarketingSurveys.scoreDistribution']]);
    expect(text).toContain(`NPS ${UNAVAILABLE} ${SOURCE_MESSAGES['adminMarketingSurveys.scoreDistribution']} ${UNAVAILABLE}`);
    expect(text).not.toContain(SOURCE_MESSAGES['adminMarketingSurveys.promoters']);
    // The controls, the share link and the newest hundred responses remain.
    expect(text).toContain(SOURCE_MESSAGES['adminMarketingSurveys.publicShareLink']);
    expect(text).toContain('The newest one');
    expect(html.split('rounded-lg bg-elevated text-sm font-bold').length - 1).toBe(100);
  });

  it('a score read that FAILS is still the survey\'s read-error state', async () => {
    db.seed('surveys', [{ id: 'srv-a', name: 'Onboarding', type: 'nps', status: 'active', slug: 'onboarding', question: 'Recommend us?', scale_min: 0, scale_max: 10, deleted_at: null }]);
    db.seed('survey_responses', [{ id: 'resp-1', survey_id: 'srv-a', score: 9, comment: 'Lovely', respondent_email: null, submitted_at: minutesAgo(1) }]);
    h.db = withFaults(db, (_table, calls) => (calls.some((c) => c.method === 'select' && c.args[0] === 'id, score') ? { message: 'scores unavailable' } : null));
    const { default: SurveyDetailPage } = await import('@/app/(app)/admin/marketing/surveys/[id]/page');
    const html = await renderServerPage(await SurveyDetailPage({ params: Promise.resolve({ id: 'srv-a' }) }));
    expect(html).toContain(SOURCE_MESSAGES['surveys.couldNotLoadThisSurvey']);
  });
});

describe('/admin/sync: Connections in error counts every connection', () => {
  it('the errored connections past the first thousand are counted', async () => {
    db.seed('sync_connections', Array.from({ length: ROWS }, (_, i) => ({ id: `conn-${pad(i)}`, health: i < CAP ? 'ok' : 'error' })));
    for (const table of ['sync_provider_errors', 'sync_jobs', 'sync_webhook_events', 'sync_providers']) db.seed(table, []);
    const { default: AdminSyncPage } = await import('@/app/(app)/admin/sync/page');
    const html = await renderServerPage(await AdminSyncPage());
    expect(statCardValue(html, SOURCE_MESSAGES['adminSync.activeConnections'])).toBe('1,300');
    expect(statCardValue(html, SOURCE_MESSAGES['adminSync.connectionsInError'])).toBe('300');
  });
});

describe('/admin/audit: a row names its family even past the first thousand families', () => {
  function seedLog() {
    db.seed('families', Array.from({ length: ROWS }, (_, i) => ({ id: `fam-${pad(i)}`, name: `Family ${i}` })));
    db.seed('profiles', []);
    db.seed('audit_logs', Array.from({ length: 25 }, (_, k) => ({
      id: `log-${pad(k)}`, family_id: `fam-${pad(ROWS - 1 - k)}`, actor_id: null, action: 'document.view', resource: `Resource ${k}`,
      metadata: null, created_at: minutesAgo(k),
    })));
  }

  it('the family column, and a search by its name', async () => {
    seedLog();
    const { default: AdminAuditPage } = await import('@/app/(app)/admin/audit/page');
    const html = await renderServerPage(await AdminAuditPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain(`<td class="px-3 py-2.5 text-muted">Family ${ROWS - 1}</td>`);
    expect(html).toContain(`<td class="px-3 py-2.5 text-muted">Family ${ROWS - 25}</td>`);

    const searched = await renderServerPage(await AdminAuditPage({ searchParams: Promise.resolve({ q: `Family ${ROWS - 1}` }) }));
    expect(searched).toContain('>Resource 0</td>');
    expect(searched).not.toContain('>Resource 1</td>');
  });

  it('a family name read that fails is the read-error state, not "—"', async () => {
    seedLog();
    h.db = withFaults(db, (table) => (table === 'families' ? { message: 'families unavailable' } : null));
    const { default: AdminAuditPage } = await import('@/app/(app)/admin/audit/page');
    const html = await renderServerPage(await AdminAuditPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain(SOURCE_MESSAGES['audit.couldNotLoadAuditLogs']);
  });

  // A transport failure (DNS, TCP, TLS, a timed-out fetch) REJECTS the query
  // instead of resolving { data, error }. Unsettled, that rejection escaped the
  // page and the route's error boundary rendered in place of the page's own
  // read-error state (review R4-AUDIT-TRANSPORT-UNSETTLED).
  it.each(['audit_logs', 'families', 'profiles'])('an unreachable %s read is the read-error state, not the error boundary', async (unreachable) => {
    seedLog();
    db.seed('profiles', [{ id: 'actor-1', full_name: 'Avery Admin', email: 'avery@example.com' }]);
    db.seed('audit_logs', [{
      id: 'log-actor', family_id: 'fam-000000', actor_id: 'actor-1', action: 'document.view', resource: 'Resource actor',
      metadata: null, created_at: minutesAgo(30),
    }]);
    h.db = withTransportFailure(db, unreachable);
    const { default: AdminAuditPage } = await import('@/app/(app)/admin/audit/page');
    const page = AdminAuditPage({ searchParams: Promise.resolve({}) });
    await expect(page).resolves.toBeDefined();
    const html = await renderServerPage(await page);
    expect(html).toContain(SOURCE_MESSAGES['audit.couldNotLoadAuditLogs']);
    expect(html).not.toContain('>Resource 0</td>');
  });

  it('the control: with every table reachable the same seed renders the log, actor named', async () => {
    seedLog();
    db.seed('profiles', [{ id: 'actor-1', full_name: 'Avery Admin', email: 'avery@example.com' }]);
    db.seed('audit_logs', [{
      id: 'log-actor', family_id: 'fam-000000', actor_id: 'actor-1', action: 'document.view', resource: 'Resource actor',
      metadata: null, created_at: minutesAgo(30),
    }]);
    h.db = withTransportFailure(db, 'no_such_table');
    const { default: AdminAuditPage } = await import('@/app/(app)/admin/audit/page');
    const html = await renderServerPage(await AdminAuditPage({ searchParams: Promise.resolve({}) }));
    expect(html).not.toContain(SOURCE_MESSAGES['audit.couldNotLoadAuditLogs']);
    expect(html).toContain('>Resource 0</td>');
    expect(html).toContain('Avery Admin');
  });
});

/**
 * The same client, with every query on `table` REJECTING the way a transport
 * failure does (supabase-js rejects only when the request never completed), and
 * every other table answering from the in-memory database.
 */
function withTransportFailure<T extends object>(client: T, table: string): T {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property !== 'from') return Reflect.get(target, property, receiver);
      return (name: string) => {
        const builder = (target as unknown as InMemorySupabase).from(name);
        if (name !== table) return builder;
        const proxy: object = new Proxy(builder, {
          get(object, key) {
            if (key === 'then') {
              return (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
                Promise.reject(new Error(`CONNECT_TIMEOUT reading ${name}`)).then(resolve, reject);
            }
            const value = Reflect.get(object, key);
            if (typeof value !== 'function') return value;
            return (...args: unknown[]) => {
              const result = Reflect.apply(value, object, args);
              return result === object ? proxy : result;
            };
          },
        });
        return proxy;
      };
    },
  });
}
