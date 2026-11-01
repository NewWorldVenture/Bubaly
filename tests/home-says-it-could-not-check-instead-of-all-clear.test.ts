// /home turned failed reads into good news. A refused parent_approvals,
// chore sign-off, runs or recommendations read, or a failed AI approvals inbox,
// left "Needs your attention" with nothing in it, so it said "Nothing needs you
// right now" over a child's pending purchase request (N5). A failed count
// answered 0 to the Family Score, which scored 100 / A "Great job!"; a failed
// open-tasks read said "No open tasks. Nicely done."; a failed chores read "No
// chores assigned."; and a failed due-today read let Today call it "A clear
// day" (N8). Driven through the real page over the in-memory database, with the
// chosen reads refused.
import React, { isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { getMessages, translate } from '@/lib/i18n/messages';
import { createInMemorySupabase, withFaults, type FaultCall } from './helpers/in-memory-supabase';

type DB = SupabaseClient<Database>;
const FAMILY = 'f1';
const NOW = '2026-10-14T10:00:00Z';
const h = vi.hoisted(() => ({ db: null as unknown, approvalsOk: true }));

const ctx = () => ({
  user: { id: 'u-parent', email: 'parent@example.test' },
  active: {
    familyId: FAMILY, role: 'parent',
    member: { id: 'm-parent', display_name: 'parent', role: 'parent' },
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
vi.mock('@/lib/calendar/source-capability', () => ({ get CALENDAR_SOURCE_ARCHIVE_ENABLED() { return false; } }));
vi.mock('@/lib/server/plan', () => ({ resolveFamilyPlanLevel: async () => 1 }));
vi.mock('@/lib/services/approvals', () => ({
  listPending: async () => (h.approvalsOk ? { ok: true, data: [] } : { ok: false, error: 'approvals unavailable' }),
}));
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
const { familyScore } = await import('@/lib/home/family-score');

const ALL_CLEAR = translate(getMessages('en-US'), 'needsAttention.nothingNeedsYouRightNowBubaly');
const GREAT_JOB = familyScore({ choresToday: 0, choresDone: 0, tasksOverdue: 0, overdueReminders: 0 }).message;

/** The NeedsAttention the page hands the browser. */
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

/** Every string the page's own markup carries, without rendering its client widgets. */
function textIn(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string' || typeof node === 'number') out.push(String(node));
  else if (Array.isArray(node)) for (const child of node) textIn(child, out);
  else if (isValidElement<Record<string, unknown>>(node)) {
    for (const value of Object.values(node.props)) if (value && typeof value === 'object' || typeof value === 'string') textIn(value, out);
  }
  return out;
}

const isCount = (calls: FaultCall[]) => calls.some((c) => c.method === 'select' && (c.args[1] as { head?: boolean } | undefined)?.head);
const refused = { code: 'XX000', message: 'statement timeout' };

async function home(fault: (table: string, calls: FaultCall[]) => boolean) {
  const base = h.db as ReturnType<typeof createInMemorySupabase<DB>>;
  h.db = withFaults(base, (table, calls) => (fault(table, calls) ? refused : null));
  const page = await HomePage();
  h.db = base;
  const element = needsAttentionIn(page);
  if (!element) throw new Error('the page rendered no "Needs your attention" list');
  const needs = renderToStaticMarkup(element).replace(/&#x27;|&#39;/g, "'");
  return { needs, text: textIn(page).join('\n') };
}

beforeEach(() => {
  h.approvalsOk = true;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const db = createInMemorySupabase<DB>({ rpc: { ensure_default_grocery_list: () => 'list-1' } });
  db.seed('families', [{ id: FAMILY, name: 'Family', timezone: 'UTC' }]);
  db.seed('family_members', [{ id: 'm-parent', family_id: FAMILY, user_id: 'u-parent', display_name: 'parent', role: 'parent', is_active: true, birthday: null, created_at: '2026-01-01T00:00:00Z' }]);
  h.db = db;
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('"Needs your attention" on /home (N5)', () => {
  it('the control: with every source answering and nothing pending, it is all clear', async () => {
    const { needs } = await home(() => false);
    expect(needs).toContain(ALL_CLEAR);
  });

  it.each([
    ['parent_approvals', (table: string) => table === 'parent_approvals'],
    ['chore sign-offs', (table: string, calls: FaultCall[]) => table === 'chore_assignments' && calls.some((c) => c.method === 'eq' && c.args[1] === 'submitted')],
    ['active runs', (table: string) => table === 'family_automation_runs'],
    ['recommendations', (table: string) => table === 'family_ai_recommendations'],
    ['overdue reminders', (table: string, calls: FaultCall[]) => table === 'family_reminders' && isCount(calls)],
  ] as const)('does not claim nothing needs you when the %s read fails', async (_name, fault) => {
    const { needs } = await home(fault);
    expect(needs).not.toContain(ALL_CLEAR);
    expect(needs).toContain('Could not check everything that needs you');
  });

  it('does not claim nothing needs you when the AI approvals inbox fails', async () => {
    h.approvalsOk = false;
    const { needs } = await home(() => false);
    expect(needs).not.toContain(ALL_CLEAR);
    expect(needs).toContain('Could not check everything that needs you');
  });
});

describe('Family Score, Tasks, Chores and Today on /home (N8)', () => {
  it('the control: answered reads give the real all-clear', async () => {
    const { text } = await home(() => false);
    expect(text).toContain(GREAT_JOB);
    expect(text).toContain('No open tasks. Nicely done.');
    expect(text).toContain('No chores assigned.');
    expect(text).toContain('A clear day — nothing scheduled and nothing due.');
  });

  it.each([
    ['overdue tasks', (table: string, calls: FaultCall[]) => table === 'todo_items' && isCount(calls)],
    ['overdue reminders', (table: string, calls: FaultCall[]) => table === 'family_reminders' && isCount(calls)],
    ['chores due today', (table: string, calls: FaultCall[]) => table === 'chore_assignments' && isCount(calls)],
  ] as const)('does not score 100 / A when the %s count fails', async (_name, fault) => {
    const { text } = await home(fault);
    expect(text).not.toContain(GREAT_JOB);
    expect(text).toContain('Could not work out the Family Score right now.');
  });

  it('does not praise an empty task list it could not read', async () => {
    const { text } = await home((table, calls) => table === 'todo_items' && calls.some((c) => c.method === 'limit' && c.args[0] === 6));
    expect(text).not.toContain('No open tasks. Nicely done.');
    expect(text).toContain('Could not load open tasks.');
  });

  it('does not say no chores are assigned when the chores read fails', async () => {
    const { text } = await home((table, calls) => table === 'chore_assignments' && calls.some((c) => c.method === 'limit' && c.args[0] === 6));
    expect(text).not.toContain('No chores assigned.');
    expect(text).toContain('Could not load chores.');
  });

  it.each([
    ['to-dos', (table: string, calls: FaultCall[]) => table === 'todo_items' && calls.some((c) => c.method === 'lte' && c.args[0] === 'due_date')],
    ['chores', (table: string, calls: FaultCall[]) => table === 'chore_assignments' && calls.some((c) => c.method === 'lt' && c.args[0] === 'due_at')],
    ['reminders', (table: string, calls: FaultCall[]) => table === 'family_reminders' && !isCount(calls)],
  ] as const)('does not call it a clear day when the due-today %s read fails', async (_name, fault) => {
    const { text } = await home(fault);
    expect(text).not.toContain('A clear day — nothing scheduled and nothing due.');
    expect(text).toContain('Could not check what is due today.');
  });
});
