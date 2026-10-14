// N7 (missed sibling) — a pending recommendation's body is the planner's
// reasoning (lib/ai/planner/index.ts, reasoning_summary), and it can touch the
// household's money or documents, which the proactive AI slice withholds from
// anyone who does not manage the family. The autonomous-management page and
// setRecommendationStatus already keep it to the parents and adults. Home, the
// AI home dashboard and /dashboard/needs-you still handed every reader's
// browser the body of every pending recommendation, and "Needs your attention"
// printed its first line under the title. Each now hands the bodies only to a
// manager, who decides the recommendation; anyone else reads its title.
//
// Driven through the real pages over the in-memory database: the props each
// hands the real NeedsAttention (what reaches the browser) and what that
// component then renders.
import React, { isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { UserContext } from '@/lib/supabase/auth';
import { getMessages, translate } from '@/lib/i18n/messages';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

type DB = SupabaseClient<Database>;
const FAMILY = 'f1';
const NOW = '2026-10-14T10:00:00Z';
const h = vi.hoisted(() => ({ db: null as unknown, role: 'parent' }));

const ctx = () => ({
  user: { id: `u-${h.role}`, email: `${h.role}@example.test` },
  active: {
    familyId: FAMILY, role: h.role,
    member: { id: `m-${h.role}`, display_name: h.role, role: h.role },
    family: { id: FAMILY, name: 'Family', timezone: 'UTC', created_at: '2026-01-01T00:00:00Z' },
  },
});

vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ctx(), requireFeature: async () => ctx(), isSuperAdmin: async () => false }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { getMessages: messages, translate: tr } = await import('@/lib/i18n/messages');
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => tr(messages('en-US'), key, params),
    getLocaleContext: async () => ({ locale: { code: 'en-US' }, source: 'default', messages: messages('en-US') }),
  };
});
// What none of this is about answers as empty.
vi.mock('@/lib/calendar/source-capability', () => ({ get CALENDAR_SOURCE_ARCHIVE_ENABLED() { return false; } }));
vi.mock('@/lib/server/plan', () => ({ resolveFamilyPlanLevel: async () => 1 }));
vi.mock('@/lib/services/approvals', () => ({ listPending: async () => ({ ok: true, data: [] }) }));
vi.mock('@/lib/services/memory', () => ({ listMemories: async () => ({ ok: true, data: { pending: [] } }) }));
vi.mock('@/lib/home/completed', () => ({ loadCompletedByBubaly: async () => ({ ok: true, data: [] }) }));
vi.mock('@/lib/schedule/intelligence-server', () => ({ loadScheduleIntelligence: async () => ({ ok: true, data: { byEvent: {} } }) }));
vi.mock('@/lib/metric/time-saved-server', () => ({ loadTimeSaved: async () => ({ show: false }) }));
vi.mock('@/components/i18n/locale-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/i18n/locale-provider')>()),
  useTranslations: () => (key: string, params?: Record<string, string | number>) => translate(getMessages('en-US'), key, params),
  useFamilyTimeZone: () => 'UTC',
}));
vi.mock('next/link', () => ({ default: ({ children, ...props }: React.ComponentProps<'a'>) => React.createElement('a', props, children) }));
vi.mock('@/components/approvals/approval-card', () => ({ ApprovalCard: () => null }));
vi.mock('@/components/dashboard/home-approval-actions', () => ({ HomeApprovalActions: () => null }));
vi.mock('@/components/family/record-actions', () => ({ RecommendationActions: () => null }));
vi.mock('@/components/concierge/needs-you-actions', () => ({ FactSuggestionActions: () => null, InboxMessageActions: () => null }));

const { NeedsAttention } = await import('@/components/concierge/needs-attention');
const { default: HomePage } = await import('@/app/(app)/home/page');
const { default: NeedsYouPage } = await import('@/app/(app)/dashboard/needs-you/page');
const { AiHomeDashboard } = await import('@/components/dashboard/ai-home-dashboard');

const TITLE = 'Cover the plumber this week';
const REASONING = 'Move $400 from the holiday savings to cover the plumber invoice.';

/** The NeedsAttention a page hands the browser, wherever it sits in the tree. */
function needsAttentionIn(node: ReactNode): React.ReactElement<React.ComponentProps<typeof NeedsAttention>> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = needsAttentionIn(child);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement<Record<string, unknown>>(node)) return null;
  if (node.type === NeedsAttention) return node as React.ReactElement<React.ComponentProps<typeof NeedsAttention>>;
  for (const value of Object.values(node.props)) {
    if (value && typeof value === 'object') {
      const found = needsAttentionIn(value as ReactNode);
      if (found) return found;
    }
  }
  return null;
}

const SURFACES: [string, () => Promise<ReactNode>][] = [
  ['/home', () => HomePage() as Promise<ReactNode>],
  ['/dashboard/needs-you', () => NeedsYouPage() as Promise<ReactNode>],
  ['the AI home dashboard', () => AiHomeDashboard({ ctx: ctx() as unknown as UserContext }) as Promise<ReactNode>],
];

/** What `role` is handed and shown on `surface`: the props that reach the browser, and the list. */
async function needsYouOn(surface: () => Promise<ReactNode>, role: string) {
  h.role = role;
  const element = needsAttentionIn(await surface());
  if (!element) throw new Error('the page rendered no "Needs your attention" list');
  return { props: JSON.stringify(element.props), html: renderToStaticMarkup(element).replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&') };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const db = createInMemorySupabase<DB>({ rpc: { ensure_default_grocery_list: () => 'list-1' } });
  db.seed('families', [{ id: FAMILY, name: 'Family', timezone: 'UTC' }]);
  db.seed('family_members', ['parent', 'adult', 'child', 'teen', 'caregiver', 'guest'].map((role, i) => ({
    id: `m-${role}`, family_id: FAMILY, user_id: `u-${role}`, display_name: role, role, is_active: true, birthday: null, created_at: `2026-01-0${i + 1}T00:00:00Z`,
  })));
  db.seed('family_ai_recommendations', [{
    id: 'rec-1', family_id: FAMILY, title: TITLE, body: `${REASONING}\nThen pay it from the joint account.`, status: 'pending',
    priority: 'high', category: 'money', cta_href: null, created_at: '2026-10-14T09:00:00Z',
  }]);
  h.db = db;
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe.each(SURFACES)('%s', (_name, surface) => {
  it.each(['parent', 'adult'])('hands a %s the recommendation with its reasoning, to decide', async (role) => {
    const { props, html } = await needsYouOn(surface, role);
    expect(html).toContain(TITLE);
    expect(html).toContain(REASONING);
    expect(props).toContain(REASONING);
  });

  it.each(['child', 'teen', 'caregiver', 'guest'])('hands a %s its title and none of its reasoning', async (role) => {
    const { props, html } = await needsYouOn(surface, role);
    expect(html).toContain(TITLE);
    for (const text of [html, props]) {
      expect(text).not.toContain('$400');
      expect(text).not.toContain('holiday savings');
      expect(text).not.toContain('joint account');
    }
  });
});
