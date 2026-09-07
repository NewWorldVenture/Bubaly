// The Daily Brief's decisions slice (M4).
//
// The load-bearing promise mirrors `handled`: a decision in the brief is a row
// somebody is actually waiting on — a pending `approval_requests` row, a run
// parked in `awaiting_approval` / `awaiting_context`, a pending money approval,
// a pending recommendation — mapped by the same `buildHomeNeeds` the Command
// Center runs. The brief never invents one, the model never writes one, and
// when there is at least one it leads the headline.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { briefSchema, buildBrief, type BriefInput } from '@/lib/briefing/build';
import { readBriefDecisions } from '@/lib/briefing/decisions';
import type { NeedItem } from '@/lib/home/needs-attention';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const NOW = new Date('2026-09-07T11:00:00Z');
const TZ = 'America/New_York';

// ─── buildBrief ───────────────────────────────────────────────────────────────

function input(over: Partial<BriefInput> = {}): BriefInput {
  return {
    kind: 'daily',
    now: NOW,
    events: [{ title: 'Dentist', start: '2026-09-07T14:00:00Z', end: '2026-09-07T15:00:00Z' }],
    snapshot: { bills: [{ name: 'Power', amount: 84, dueDate: '2026-09-03' }] },
    completedRuns: [
      { id: 'run-1', state: 'completed', summary: 'Planned the week', progress: { total: 8, completed: 8 }, completed_at: '2026-09-07T09:00:00Z', updated_at: '2026-09-07T09:00:00Z' },
    ],
    activity: [],
    ...over,
  } as BriefInput;
}

const DECISIONS: NeedItem[] = [
  { id: 'recommendation:rec-1', kind: 'recommendation', title: 'Move piano to Thursday', href: '/dashboard/autonomous-family-management', urgency: 'normal', createdAt: '2026-09-07T10:00:00Z' },
  { id: 'ai_approval:ap-1', kind: 'ai_approval', title: 'Book the plumber for Tuesday 9am', href: '/dashboard/concierge/runs/run-a', urgency: 'urgent', createdAt: '2026-09-07T08:00:00Z' },
  { id: 'run:run-q', kind: 'run_awaiting_answer', title: 'Plan the weekend — Bubaly has a question', href: '/dashboard/concierge/runs/run-q', urgency: 'urgent', createdAt: '2026-09-07T09:30:00Z' },
];

describe('buildBrief decisions', () => {
  it('leads the morning headline with what needs deciding, ranked the way Home ranks it', () => {
    const brief = buildBrief(input({ decisions: DECISIONS }), TZ);
    expect(brief.headline).toMatch(/^3 decisions need you, /);
    // Calendar and money still follow — decisions come first, they do not replace the day.
    expect(brief.headline).toMatch(/1 thing today/);
    expect(brief.headline).toMatch(/1 overdue/);
    // Urgent before normal, newest first among equals: the run parked on a
    // question (09:30) ahead of the approval (08:00), the recommendation last.
    expect(brief.decisions.map((d) => d.id)).toEqual(['run:run-q', 'ai_approval:ap-1', 'recommendation:rec-1']);
    expect(brief.counts.decisions).toBe(3);
    expect(briefSchema.safeParse(brief).success).toBe(true);
  });

  it('says "1 decision needs you" for one, and leads the evening too', () => {
    const one = buildBrief(input({ decisions: [DECISIONS[1]] }), TZ);
    expect(one.headline).toMatch(/^1 decision needs you, /);

    const evening = buildBrief(input({ kind: 'evening', decisions: [DECISIONS[1]] }), TZ);
    expect(evening.headline).toMatch(/^1 decision needs you, Bubaly finished 1 thing today/);
  });

  it('is silent about decisions when there are none, and the old headline is unchanged', () => {
    const brief = buildBrief(input(), TZ);
    expect(brief.decisions).toEqual([]);
    expect(brief.counts.decisions).toBe(0);
    expect(brief.headline).not.toMatch(/decision/);
    expect(brief.headline).toMatch(/^1 thing today/);
  });

  it('does not call a day with only a decision on it sparse', () => {
    const brief = buildBrief(input({ events: [], snapshot: {}, completedRuns: [], activity: [], decisions: [DECISIONS[1]] }), TZ);
    expect(brief.isSparse).toBe(false);
    expect(brief.headline).toBe('1 decision needs you.');
  });

  it('refuses a decision that would link off the app', () => {
    const brief = buildBrief(input({ decisions: [{ ...DECISIONS[1], href: 'https://evil.example/approve' }] }), TZ);
    expect(briefSchema.safeParse(brief).success).toBe(false);
  });
});

// ─── readBriefDecisions ───────────────────────────────────────────────────────

function approvalRow(over: Record<string, unknown>) {
  return {
    family_id: 'fam-1', status: 'pending', domain: 'reminders', capability: 'reminders.create',
    requested_by_kind: 'ai', requested_by_member_id: null, agent: null, summary: null,
    payload: { name: 'reminders.create', args: { title: 'Pack the cleats' } }, payload_kind: 'tool',
    amount_cents: null, confidence: null, reasoning: null, required_approvals: 1, approval_model: null,
    approvals: [], priority: 'normal', expires_at: null, run_id: null, plan_step_id: null, plan_step_ids: null,
    consequences: ['A reminder is created'], edited_payload: null,
    ...over,
  };
}

function seededDb() {
  const db = createInMemorySupabase();
  db.seed('family_members', [
    { id: 'm-parent', family_id: 'fam-1', user_id: 'auth-parent', display_name: 'Alex', role: 'parent', is_active: true },
    { id: 'm-child', family_id: 'fam-1', user_id: 'auth-child', display_name: 'Sam', role: 'child', is_active: true },
  ]);
  db.seed('approval_requests', [
    approvalRow({ id: 'ap-gated', title: 'Book the plumber for Tuesday 9am', run_id: 'run-gated', created_at: '2026-09-07T08:00:00Z' }),
    approvalRow({ id: 'ap-plain', title: 'Add a reminder to pack the cleats', created_at: '2026-09-07T09:00:00Z' }),
    approvalRow({ id: 'ap-done', title: 'Already decided', status: 'approved', created_at: '2026-09-06T09:00:00Z' }),
    approvalRow({ id: 'ap-other', title: 'Another family', family_id: 'fam-2', created_at: '2026-09-07T09:30:00Z' }),
  ]);
  db.seed('family_automation_runs', [
    { id: 'run-gated', family_id: 'fam-1', summary: 'Fix the leak', state: 'awaiting_approval', updated_at: '2026-09-07T08:00:00Z', created_at: '2026-09-07T07:00:00Z' },
    { id: 'run-q', family_id: 'fam-1', summary: 'Plan the weekend', state: 'awaiting_context', updated_at: '2026-09-07T09:30:00Z', created_at: '2026-09-07T07:00:00Z' },
    { id: 'run-busy', family_id: 'fam-1', summary: 'Still going', state: 'executing', updated_at: '2026-09-07T10:00:00Z', created_at: '2026-09-07T07:00:00Z' },
    { id: 'run-done', family_id: 'fam-1', summary: 'Planned the week', state: 'completed', progress: { total: 3, completed: 3 }, completed_at: '2026-09-07T06:00:00Z', updated_at: '2026-09-07T06:00:00Z', created_at: '2026-09-07T05:00:00Z' },
  ]);
  db.seed('family_ai_recommendations', [
    { id: 'rec-1', family_id: 'fam-1', title: 'Move piano to Thursday', status: 'pending', priority: 'normal', cta_href: null, created_at: '2026-09-07T10:00:00Z' },
    { id: 'rec-2', family_id: 'fam-1', title: 'Old idea', status: 'accepted', priority: 'normal', cta_href: null, created_at: '2026-09-06T10:00:00Z' },
  ]);
  db.seed('parent_approvals', [
    { id: 'pa-1', family_id: 'fam-1', kind: 'card_spend', amount_cents: 1250, status: 'pending', created_at: '2026-09-07T10:30:00Z' },
    { id: 'pa-2', family_id: 'fam-1', kind: 'card_spend', amount_cents: 500, status: 'approved', created_at: '2026-09-06T10:30:00Z' },
  ]);
  return db;
}

function scopeFor(db: unknown, role: ServiceScope['role'], memberId: string | null): ServiceScope {
  return {
    db: db as ServiceScope['db'], familyId: 'fam-1', userId: memberId ? `auth-${memberId.replace('m-', '')}` : null, memberId,
    role, actorKind: role === 'system' ? 'system' : 'member', tz: TZ, now: NOW,
  };
}

describe('readBriefDecisions', () => {
  it('reads every pending approval, parked run and recommendation the way Home does, for a manager', async () => {
    const db = seededDb();
    const res = await readBriefDecisions(scopeFor(db, 'parent', 'm-parent'));
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const ids = res.data.items.map((i) => i.id);
    expect(ids).toContain('ai_approval:ap-gated');
    expect(ids).toContain('ai_approval:ap-plain');
    // The run the approval gates is ONE decision with it, not two lines.
    expect(ids).not.toContain('run:run-gated');
    // A run waiting on an answer is a decision; a run that is executing is not.
    expect(ids).toContain('run:run-q');
    expect(ids).not.toContain('run:run-busy');
    // Terminal states, other families and decided rows never appear.
    expect(ids).not.toContain('run:run-done');
    expect(ids).not.toContain('ai_approval:ap-done');
    expect(ids).not.toContain('ai_approval:ap-other');
    expect(ids).toContain('recommendation:rec-1');
    expect(ids).not.toContain('recommendation:rec-2');
    expect(ids).toContain('approval:pa-1');
    expect(ids).not.toContain('approval:pa-2');

    expect(res.data.items.find((i) => i.id === 'run:run-q')).toMatchObject({ kind: 'run_awaiting_answer', href: '/dashboard/concierge/runs/run-q' });
    // The card data the approval card renders, keyed by approval id.
    expect(res.data.approvals['ap-gated']).toMatchObject({ id: 'ap-gated', title: 'Book the plumber for Tuesday 9am', runId: 'run-gated', requestedBy: 'Bubaly' });
    expect(res.data.moneyApprovalKinds).toEqual({ 'pa-1': 'card_spend' });
    expect(res.data.canDecide).toBe(true);
  });

  it('never reads the money table for a child, and hands them a read-only list', async () => {
    const db = seededDb();
    const res = await readBriefDecisions(scopeFor(db, 'child', 'm-child'));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(db.log.some((l) => l.table === 'parent_approvals')).toBe(false);
    expect(res.data.items.some((i) => i.kind === 'approval')).toBe(false);
    expect(res.data.moneyApprovalKinds).toEqual({});
    expect(res.data.canDecide).toBe(false);
    // The rest is still theirs to see — a question on their own run, say.
    expect(res.data.items.map((i) => i.id)).toContain('run:run-q');
  });

  it('treats the cron as a manager: a system scope sees the money approvals', async () => {
    const db = seededDb();
    const res = await readBriefDecisions(scopeFor(db, 'system', null));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.items.map((i) => i.id)).toContain('approval:pa-1');
    expect(res.data.canDecide).toBe(true);
  });

  it('fails closed when a read errors instead of reporting nothing to decide', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = { message: 'permission denied for table approval_requests', code: '42501', details: null, hint: null };
    const chain = (reply: { data: unknown; error: unknown }) => {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'order', 'limit', 'neq', 'gte', 'lte', 'is', 'not']) b[m] = () => b;
      b.then = (resolve: (v: unknown) => void) => resolve(reply);
      return b;
    };
    const db = { from: (table: string) => chain(table === 'approval_requests' ? { data: null, error: failing } : { data: [], error: null }) };

    const res = await readBriefDecisions(scopeFor(db, 'parent', 'm-parent'));
    expect(res).toMatchObject({ ok: false, retryable: true });
    expect(err.mock.calls.map((c) => String(c[0]))).toContain('[briefing] pending approvals read failed');
    err.mockRestore();
  });
});

// ─── The route's envelope ─────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(),
  createServer: vi.fn(),
  isAIConfigured: vi.fn(),
  resolveProvider: vi.fn(),
  enforceAIRateLimit: vi.fn(),
  readBoundedRequestJsonOrEmpty: vi.fn(),
  from: vi.fn(),
}));

vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/lib/ai/provider', () => ({ isAIConfigured: mocks.isAIConfigured, resolveProvider: mocks.resolveProvider }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: mocks.enforceAIRateLimit }));
vi.mock('@/lib/server/bounded-request-body', () => ({
  MAX_SMALL_JSON_BYTES: 16 * 1024,
  readBoundedRequestJsonOrEmpty: mocks.readBoundedRequestJsonOrEmpty,
}));

import { POST } from '@/app/api/ai/briefing/route';

function queryResult(data: unknown[] | null, error: unknown = null) {
  const promise = Promise.resolve({ data, error });
  const query: Record<string, unknown> = { then: promise.then.bind(promise) };
  for (const method of ['select', 'eq', 'gte', 'lte', 'gt', 'order', 'limit', 'in', 'neq', 'is', 'not']) {
    query[method] = vi.fn(() => query);
  }
  return query;
}

function requestBriefing(type = 'morning') {
  mocks.readBoundedRequestJsonOrEmpty.mockResolvedValue({ ok: true, value: { type } });
  return POST(new NextRequest('http://localhost/api/ai/briefing', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type }),
  }));
}

describe('the briefing route carries decisions', () => {
  const runs = [
    { id: 'run-done', summary: 'Planned the week', state: 'completed', progress: { total: 3, completed: 3 }, completed_at: '2026-09-07T06:00:00Z', updated_at: '2026-09-07T06:00:00Z', created_at: '2026-09-07T05:00:00Z' },
    { id: 'run-q', summary: 'Plan the weekend', state: 'awaiting_context', progress: null, completed_at: null, updated_at: '2026-09-07T09:30:00Z', created_at: '2026-09-07T07:00:00Z' },
  ];
  const pending = [approvalRow({ id: 'ap-plain', title: 'Add a reminder to pack the cleats', created_at: '2026-09-07T09:00:00Z' })];

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mocks.requireUserContext.mockResolvedValue({
      user: { id: 'auth-parent' },
      active: { familyId: 'fam-1', role: 'parent', family: { name: 'Example', timezone: TZ }, member: { id: 'm-parent', display_name: 'Alex Example', role: 'parent' } },
    });
    mocks.createServer.mockResolvedValue({ from: mocks.from });
    mocks.enforceAIRateLimit.mockResolvedValue({ ok: true });
    mocks.isAIConfigured.mockResolvedValue(false);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('puts the pending approval and the run waiting on an answer in the envelope, ranked', async () => {
    mocks.from.mockImplementation((table: string) => queryResult(
      table === 'approval_requests' ? pending
        : table === 'family_automation_runs' ? runs
        : table === 'family_members' ? [{ id: 'm-parent', display_name: 'Alex', role: 'parent' }]
        : [],
    ));
    const response = await requestBriefing();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.decisions).toBeDefined();
    expect(body.decisions.items.map((i: NeedItem) => i.id)).toEqual(['run:run-q', 'ai_approval:ap-plain']);
    expect(body.decisions.approvals['ap-plain']).toMatchObject({ title: 'Add a reminder to pack the cleats' });
    expect(body.decisions.canDecide).toBe(true);
    // "Completed" is still evidence, and the parked run is not part of it.
    expect(body.briefing.completed).toEqual(['Planned the week']);
  });

  it('omits the slice entirely when nothing is waiting, so the pinned envelope is unchanged', async () => {
    mocks.from.mockImplementation(() => queryResult([]));
    const response = await requestBriefing();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(['briefing', 'digest', 'generatedAt']);
  });

  it('fails the request when the decisions read fails rather than serving a calm brief', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.from.mockImplementation((table: string) => table === 'approval_requests'
      ? queryResult(null, { message: 'permission denied', code: '42501', details: null, hint: null })
      : queryResult([]));
    const response = await requestBriefing();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to generate briefing' });
    expect(err.mock.calls.map((c) => String(c[0]))).toContain('[briefing] decisions read failed');
  });
});
