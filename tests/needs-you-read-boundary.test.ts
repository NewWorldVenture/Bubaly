// /dashboard/needs-you (M5) renders EVERY decision waiting on a person — Home
// caps at five, this page does not — and, because "nothing needs you" is a
// claim, fails closed when any source cannot be read.
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(), createServer: vi.fn(), createServiceClient: vi.fn(),
  listPending: vi.fn(), listMemories: vi.fn(),
}));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer, createServiceClient: mocks.createServiceClient }));
vi.mock('@/lib/i18n/server', async () => {
  // The page is invoked directly, outside a request scope, so cookies() is
  // unavailable. Resolve through the real catalogue so the assertions keep
  // checking the words a person sees.
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
vi.mock('@/lib/services/approvals', async (importOriginal) => ({ ...(await importOriginal<object>()), listPending: mocks.listPending }));
vi.mock('@/lib/services/memory', async (importOriginal) => ({ ...(await importOriginal<object>()), listMemories: mocks.listMemories }));
vi.mock('next/link', () => ({ default: ({ href, children, ...props }: { href: string; children: ReactNode }) => createElement('a', { ...props, href }, children) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => '/dashboard/needs-you' }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

import NeedsYouPage from '@/app/(app)/dashboard/needs-you/page';

type Reply = { data: unknown; count?: number | null; error: unknown };
type Query = { table: string; filters: { method: string; key: string; value: unknown }[]; options?: { count?: string; head?: boolean } };

let replies: Record<string, Reply>;
let queries: Query[];

// A chainable PostgREST stub: every filter/order/limit returns the builder and
// awaiting it resolves to the configured reply for the table.
function from(table: string) {
  const record: Query = { table, filters: [] };
  queries.push(record);
  const query: Record<string, unknown> = {};
  Object.assign(query, {
    select: (_selection: string, options?: Query['options']) => { record.options = options; return query; },
    order: () => query,
    limit: () => query,
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(replies[table] ?? { data: [], count: 0, error: null }).then(resolve, reject),
  });
  for (const method of ['eq', 'neq', 'in', 'is', 'not', 'lt', 'lte', 'gt', 'gte']) {
    query[method] = (key: string, value: unknown) => { record.filters.push({ method, key, value }); return query; };
  }
  return query;
}

const ctx = (role: 'parent' | 'child') => ({
  user: { id: 'user-1', email: 'parent@example.com' },
  memberships: [],
  active: { familyId: 'fam-1', role, member: { id: 'member-1', role, display_name: 'Sam' }, family: { id: 'fam-1', name: 'Rivera', timezone: 'UTC' } },
});

const approval = (id: string, title: string) => ({
  id, title, summary: null, consequences: [], domain: 'calendar', requestedBy: null, requestedAt: '2026-09-07T11:00:00Z',
  expiresAt: null, runId: null, amountCents: null, canEdit: false,
});

const TITLES = [
  'Book the plumber for Tuesday', 'Add soccer practice Saturday',
  'Go-to dinner: Taco night', 'Grocery staple: Oat milk',
  'Plan our week — Bubaly has a question', 'Prepare the beach trip — waiting for your OK',
  'Move dentist to Thursday',
  'Card purchase to approve · $12', 'Allowance request to approve',
  '3 chores awaiting approval', '1 reminder overdue',
  'Reply to Dr. Patel — Can we move the dentist to Thursday?', 'Reply to grandma@example.com — Playdate Saturday?',
  'Sign and return — Field trip permission slip · due in 12d', 'Make the payment — Field trip permission slip · $45 · due in 12d',
];

function healthyReplies(): Record<string, Reply> {
  return {
    family_automation_runs: { data: [
      { id: 'run-1', summary: 'Plan our week', state: 'awaiting_context', updated_at: '2026-09-07T10:00:00Z' },
      { id: 'run-2', summary: 'Prepare the beach trip', state: 'awaiting_approval', updated_at: '2026-09-07T09:00:00Z' },
    ], error: null },
    family_ai_recommendations: { data: [{ id: 'rec-1', title: 'Move dentist to Thursday', body: 'Thursday is free.', priority: 'medium', cta_href: null, created_at: '2026-09-06T09:00:00Z' }], error: null },
    parent_approvals: { data: [
      { id: 'pa-1', kind: 'card_spend', amount_cents: 1200, created_at: '2026-09-07T08:00:00Z' },
      { id: 'pa-2', kind: 'allowance_request', amount_cents: null, created_at: '2026-09-07T07:00:00Z' },
    ], error: null },
    chore_assignments: { data: null, count: 3, error: null },
    family_reminders: { data: null, count: 1, error: null },
    family_inbox_messages: { data: [
      { id: 'msg-1', direction: 'inbound', from_addr: 'Dr. Patel', subject: null, ai_summary: 'Can we move the dentist to Thursday?', body: null, ai_intent: 'appointment', status: 'new', occurred_at: '2026-09-07T10:30:00Z' },
      { id: 'msg-2', direction: 'inbound', from_addr: 'grandma@example.com', subject: 'Playdate Saturday?', ai_summary: null, body: null, ai_intent: 'personal', status: 'new', occurred_at: '2026-09-07T06:00:00Z' },
    ], error: null },
    paperwork_items: { data: [{
      id: 'pw-1', title: 'Field trip permission slip', status: 'needs_action', urgency: 'soon', due_on: '2026-09-20', created_at: '2026-09-05T08:00:00Z',
      actions: [
        { kind: 'sign', label: 'Sign and return', due_on: null, amount: null, materialized_as: null, materialized_id: null },
        { kind: 'pay', label: 'Make the payment', due_on: null, amount: 45, materialized_as: null, materialized_id: null },
      ],
    }], error: null },
  };
}

const render = async () => renderToStaticMarkup(await NeedsYouPage());

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-07T12:00:00.000Z'));
  replies = healthyReplies();
  queries = [];
  mocks.requireUserContext.mockResolvedValue(ctx('parent'));
  mocks.createServer.mockResolvedValue({ from });
  mocks.listPending.mockResolvedValue({ ok: true, data: [approval('ap-1', 'Book the plumber for Tuesday'), approval('ap-2', 'Add soccer practice Saturday')] });
  mocks.listMemories.mockResolvedValue({ ok: true, data: { facts: [], pending: [
    { id: 'sug-1', label: 'Go-to dinner', value: 'Taco night', expires_at: null, created_at: '2026-09-06T09:00:00Z', status: 'suggested' },
    { id: 'sug-2', label: 'Grocery staple', value: 'Oat milk', expires_at: null, created_at: '2026-09-05T09:00:00Z', status: 'suggested' },
  ] } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Live fetch is forbidden'); }));
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('/dashboard/needs-you', () => {
  it('renders the whole queue, uncapped, with every source present and the decisions inline', async () => {
    const html = await render();
    // Fifteen items — three times Home's cap — and every one of them is on the page.
    for (const title of TITLES) expect(html, title).toContain(title);
    expect(html).toContain('15 things need you');
    expect(html).not.toContain('more items need you');
    expect(html).not.toContain('Nothing needs you right now');
    expect(html).toContain('Needs your decision');
    // The M5 decisions are made right here: Confirm / Dismiss on a memory,
    // Reply / Archive on a message, and the paperwork cards deep-link to the item.
    expect(html).toContain('Confirm');
    expect(html).toContain('Dismiss');
    expect(html).toContain('Archive');
    expect(html).toContain('href="/dashboard/contact-center#inbox-message-msg-1"');
    expect(html).toContain('href="/dashboard/playbook#suggestion-sug-1"');
    expect(html).toContain('href="/dashboard/paperwork#paperwork-pw-1"');
    expect(console.error).not.toHaveBeenCalled();
  });

  it('scopes every table read to the family and asks only for the message intents a person answers', async () => {
    await render();
    for (const q of queries) {
      expect(q.filters, q.table).toContainEqual({ method: 'eq', key: 'family_id', value: 'fam-1' });
    }
    const inbox = queries.find((q) => q.table === 'family_inbox_messages')!;
    expect(inbox.filters).toContainEqual({ method: 'eq', key: 'status', value: 'new' });
    expect(inbox.filters).toContainEqual({ method: 'eq', key: 'direction', value: 'inbound' });
    expect(inbox.filters).toContainEqual({ method: 'in', key: 'ai_intent', value: ['appointment', 'personal'] });
    const paperwork = queries.find((q) => q.table === 'paperwork_items')!;
    expect(paperwork.filters).toContainEqual({ method: 'in', key: 'status', value: ['needs_action', 'in_progress'] });
    expect(mocks.listMemories).toHaveBeenCalledWith(expect.objectContaining({ familyId: 'fam-1', role: 'parent' }));
  });

  it('fails closed when a table read errors: a retryable error state, no items, and a diagnosable log', async () => {
    replies.family_inbox_messages = { data: null, error: { message: 'permission denied for table family_inbox_messages' } };
    const html = await render();
    expect(html).toContain('Could not load what needs you');
    for (const title of TITLES) expect(html, title).not.toContain(title);
    expect(html).not.toContain('Nothing needs you right now');
    expect(html).not.toContain('things need you');
    expect(console.error).toHaveBeenCalledWith('[needs-you] inbox messages read failed', expect.objectContaining({ message: expect.stringContaining('permission denied') }));
  });

  it('fails closed the same way when a service read fails', async () => {
    mocks.listMemories.mockResolvedValue({ ok: false, error: 'Could not load family memory.', code: 'db' });
    const html = await render();
    expect(html).toContain('Could not load what needs you');
    expect(html).not.toContain('Book the plumber for Tuesday');
    expect(console.error).toHaveBeenCalledWith('[needs-you] memory suggestions read failed', 'Could not load family memory.');
  });

  it('gives a child the same list read-only: no money approvals read, no decision buttons', async () => {
    mocks.requireUserContext.mockResolvedValue(ctx('child'));
    const html = await render();
    expect(queries.map((q) => q.table)).not.toContain('parent_approvals');
    expect(html).toContain('Reply to Dr. Patel');
    expect(html).not.toContain('Archive');
    expect(html).not.toContain('Dismiss');
    expect(html).not.toContain('Could not load what needs you');
  });
});
