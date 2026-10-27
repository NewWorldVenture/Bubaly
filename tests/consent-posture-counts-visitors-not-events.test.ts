import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderServerPage } from './helpers/render-server-page';

// admin-writers N18. Visitor Intelligence's Consent posture tiles counted
// `granted` EVENTS in an append-only log that takes one row per category on
// every save: a visitor who accepted and later withdrew still counted, each
// re-save counted again, and one "Accept all" counted twice as a marketing
// opt-in (email and SMS are two rows). The resolver and the contact score read
// the latest decision per category; the tiles now count visitors whose latest
// decision is a grant. The REAL page against the in-memory database.

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES: messages } = await import('@/lib/i18n/messages');
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(messages, key, params),
    getLocaleContext: async () => ({ locale: { code: 'en-US' }, messages }),
  };
});

let db: InMemorySupabase;
let seq = 0;
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 1) + minutes * 60_000).toISOString();
function decide(visitor: string, minutes: number, decisions: Record<string, 'granted' | 'denied'>) {
  db.seed('mkt_consent_events', Object.entries(decisions).map(([category, decision]) => ({
    id: `ev-${String(++seq).padStart(4, '0')}`, anonymous_id: visitor, category, decision, created_at: at(minutes), policy_version: '1',
  })));
}
async function tile(label: string): Promise<string | undefined> {
  const { default: VisitorIntelligencePage } = await import('@/app/(app)/admin/marketing/visitor-intelligence/page');
  const html = await renderServerPage(await VisitorIntelligencePage());
  return new RegExp(`<p class="text-2xl font-black tabular-nums">([^<]*)</p><p class="text-xs text-muted">${label}</p>`).exec(html)?.[1];
}
const ANALYTICS = SOURCE_MESSAGES['adminMarketingVisitorIntelligence.visitorsAllowingAnalytics'];
const MARKETING = SOURCE_MESSAGES['adminMarketingVisitorIntelligence.visitorsOptedInToMarketing'];
const ALL = { necessary: 'granted', analytics: 'granted', personalization: 'granted', marketing_email: 'granted', marketing_sms: 'granted' } as const;

beforeEach(() => {
  seq = 0;
  db = createInMemorySupabase({ maxRows: 1000 });
  h.db = db;
  for (const table of ['mkt_visitors', 'crm_contact_profile', 'crm_lead_scores', 'mkt_consent_events']) db.seed(table, []);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('the consent posture tiles', () => {
  it('count visitors whose CURRENT decision is a grant', async () => {
    // A: Accept all, then withdrew analytics in the preference center.
    decide('visitor-a', 1, ALL);
    decide('visitor-a', 5, { ...ALL, analytics: 'denied' });
    // B: Accept all, saved again from the footer, unchanged.
    decide('visitor-b', 2, ALL);
    decide('visitor-b', 6, ALL);
    // C: opted in to marketing email, then out of everything but analytics.
    decide('visitor-c', 3, { analytics: 'granted', marketing_email: 'granted' });
    decide('visitor-c', 7, { analytics: 'granted', marketing_email: 'denied', marketing_sms: 'denied' });
    // D: only ever refused.
    decide('visitor-d', 4, { analytics: 'denied', marketing_email: 'denied', marketing_sms: 'denied' });

    // Grant EVENTS: analytics 5, marketing 9. Visitors who allow analytics now:
    // B and C. Visitors opted in to email or SMS marketing now: A and B.
    expect(await tile(ANALYTICS)).toBe('2');
    expect(await tile(MARKETING)).toBe('2');
  });

  it('the latest decision wins whatever order the ids sort in', async () => {
    // mkt_consent_events.id is gen_random_uuid() (0160_visitor_consent.sql):
    // a later decision's id sorts BEFORE an earlier one's as often as after,
    // and the read pages in id order. The fixture ids above rise with time,
    // so "last row read wins" would pass them; these do not.
    db.seed('mkt_consent_events', [
      // A: granted analytics, then withdrew it. The withdrawal's id sorts first.
      { id: 'f0a1c3e2-0000-4000-8000-000000000001', anonymous_id: 'visitor-a', category: 'analytics', decision: 'granted', created_at: at(1), policy_version: '1' },
      { id: '0b7d9e14-0000-4000-8000-000000000002', anonymous_id: 'visitor-a', category: 'analytics', decision: 'denied', created_at: at(5), policy_version: '1' },
      // B: refused marketing email, then opted in. The opt-in's id sorts first.
      { id: 'e9c2a4b6-0000-4000-8000-000000000003', anonymous_id: 'visitor-b', category: 'marketing_email', decision: 'denied', created_at: at(2), policy_version: '1' },
      { id: '1a3f5c7e-0000-4000-8000-000000000004', anonymous_id: 'visitor-b', category: 'marketing_email', decision: 'granted', created_at: at(6), policy_version: '1' },
    ]);
    expect(await tile(ANALYTICS), 'a withdrawn grant counted because its id sorted last').toBe('0');
    expect(await tile(MARKETING), 'a current opt-in was lost because an older refusal sorted last').toBe('1');
  });

  it('a visitor who withdrew everything is no longer counted', async () => {
    decide('visitor-a', 1, ALL);
    expect(await tile(MARKETING)).toBe('1');
    decide('visitor-a', 2, { ...ALL, analytics: 'denied', marketing_email: 'denied', marketing_sms: 'denied' });
    expect(await tile(ANALYTICS)).toBe('0');
    expect(await tile(MARKETING)).toBe('0');
  });
});
