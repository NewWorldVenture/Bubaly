// The brief a child reads carries no money, bills or medication content.
//
// `lib/ai/context/policy.ts` decides, before any slice runs, that a child's
// prompt context never carries the money slice (§4). The briefing route reads
// its own rows outside that builder, so the same rule is applied at the
// source here: for a viewer who cannot manage the family, the bills,
// medication-schedule and money-approval reads are not made at all. Not
// read-then-hidden — not read — so nothing can reach the model, the fallback
// or the envelope by mistake. This file pins that, and that a manager still
// gets all three.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(),
  createServer: vi.fn(),
  isAIConfigured: vi.fn(),
  resolveProvider: vi.fn(),
  complete: vi.fn(),
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
// The model's answer is recorded as an `ai_requests` row through the same
// mocked client; the wrapper is not what this file tests.
vi.mock('@/lib/ai/observability', () => ({
  withAiRequest: async (_scope: unknown, _spec: unknown, body: (obs: { used: () => void }) => Promise<unknown>) => body({ used: () => {} }),
}));

import { POST } from '@/app/api/ai/briefing/route';

const NOW = new Date('2026-09-07T11:00:00Z'); // 7am in New York, a Monday
const TZ = 'America/New_York';

const BILL = { name: 'Electric bill', amount: 120, due_date: '2026-09-06', status: 'unpaid' };
const MED_SCHEDULE = {
  time_of_day: '08:00', days_of_week: [0, 1, 2, 3, 4, 5, 6], starts_on: '2026-01-01', ends_on: null,
  medications: { name: 'Amoxicillin', member_id: 'm-child', is_active: true },
};
const MONEY_APPROVAL = { id: 'pa-1', kind: 'card_spend', amount_cents: 1250, created_at: '2026-09-07T10:30:00Z' };
const PANTRY = { name: 'Milk', expires_at: '2026-09-08' };

function queryResult(data: unknown[]) {
  const promise = Promise.resolve({ data, error: null });
  const query: Record<string, unknown> = { then: promise.then.bind(promise) };
  for (const method of ['select', 'eq', 'gte', 'lte', 'gt', 'order', 'limit', 'in', 'neq', 'is', 'not']) {
    query[method] = vi.fn(() => query);
  }
  return query;
}

/** Every table answers with the rows a money/health-carrying family has, so a read that IS made shows up. */
function familyTables(table: string): unknown[] {
  switch (table) {
    case 'family_members': return [
      { id: 'm-parent', display_name: 'Alex', role: 'parent' },
      { id: 'm-child', display_name: 'Sam', role: 'child' },
    ];
    case 'bills': return [BILL];
    case 'medication_schedules': return [MED_SCHEDULE];
    case 'parent_approvals': return [MONEY_APPROVAL];
    case 'pantry_items': return [PANTRY];
    default: return [];
  }
}

function signIn(role: 'parent' | 'child') {
  mocks.requireUserContext.mockResolvedValue({
    user: { id: `auth-${role}` },
    active: {
      familyId: 'fam-1', role, family: { name: 'Example', timezone: TZ },
      member: { id: `m-${role}`, display_name: role === 'parent' ? 'Alex Example' : 'Sam Example', role },
    },
  });
}

function requestBriefing(type = 'morning') {
  mocks.readBoundedRequestJsonOrEmpty.mockResolvedValue({ ok: true, value: { type } });
  return POST(new NextRequest('http://localhost/api/ai/briefing', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type }),
  }));
}

const tablesRead = () => mocks.from.mock.calls.map((c) => c[0] as string);
const MANAGER_ONLY = ['bills', 'medication_schedules', 'parent_approvals'];

describe('the brief a child reads', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mocks.createServer.mockResolvedValue({ from: mocks.from });
    mocks.from.mockImplementation((table: string) => queryResult(familyTables(table)));
    mocks.enforceAIRateLimit.mockResolvedValue({ ok: true });
    mocks.isAIConfigured.mockResolvedValue(false);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('never reads bills, medication schedules or money approvals, and carries none of them', async () => {
    signIn('child');
    const response = await requestBriefing();
    expect(response.status).toBe(200);
    const body = await response.json();

    for (const table of MANAGER_ONLY) expect(tablesRead()).not.toContain(table);

    const text = JSON.stringify(body);
    expect(text).not.toContain('Electric bill');
    expect(text).not.toContain('Amoxicillin');
    expect(text).not.toContain('card_spend');
    expect(body.digest.items.map((i: { domain: string }) => i.domain)).not.toContain('bill');
    expect(body.digest.items.map((i: { domain: string }) => i.domain)).not.toContain('medication');
    // The rest of the day is still theirs: the pantry item is not money or health.
    expect(body.digest.items.map((i: { domain: string }) => i.domain)).toContain('pantry');
    expect(body.decisions).toBeUndefined();
  });

  it('keeps the money and health rows out of the model prompt as well', async () => {
    signIn('child');
    mocks.isAIConfigured.mockResolvedValue(true);
    mocks.resolveProvider.mockResolvedValue({ complete: mocks.complete });
    // An unparseable answer takes the deterministic path; what matters here
    // is what the model was SHOWN.
    mocks.complete.mockResolvedValue({ text: 'not json', toolCalls: [] });

    const response = await requestBriefing();
    expect(response.status).toBe(200);
    expect(mocks.complete).toHaveBeenCalledTimes(1);
    const prompt = JSON.stringify(mocks.complete.mock.calls[0][0]);
    expect(prompt).not.toContain('Electric bill');
    expect(prompt).not.toContain('Amoxicillin');
    expect(prompt).toContain('Milk');
  });

  it('gives a manager all three', async () => {
    signIn('parent');
    const response = await requestBriefing();
    expect(response.status).toBe(200);
    const body = await response.json();

    for (const table of MANAGER_ONLY) expect(tablesRead()).toContain(table);
    const domains = body.digest.items.map((i: { domain: string }) => i.domain);
    expect(domains).toContain('bill');
    expect(domains).toContain('medication');
    expect(body.briefing.reminders.map((r: { text: string }) => r.text)).toEqual(
      expect.arrayContaining([expect.stringContaining('Electric bill'), expect.stringContaining('Amoxicillin')]),
    );
    expect(body.decisions.items.map((i: { kind: string }) => i.kind)).toContain('approval');
    expect(body.decisions.moneyApprovalKinds).toEqual({ 'pa-1': 'card_spend' });
    expect(body.decisions.canDecide).toBe(true);
  });

  it('treats a missing role as not a manager', async () => {
    mocks.requireUserContext.mockResolvedValue({
      user: { id: 'auth-x' },
      active: { familyId: 'fam-1', family: { name: 'Example', timezone: TZ }, member: { display_name: 'Someone' } },
    });
    const response = await requestBriefing();
    expect(response.status).toBe(200);
    for (const table of MANAGER_ONLY) expect(tablesRead()).not.toContain(table);
  });
});
