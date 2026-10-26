// /family/reports (and Operations, Autonomous Management and the stress page,
// which read the same signals bundle) showed a guest the household's bill
// counts — "N bills due soon", "X of Y tracked bills are paid" — and folded
// those bills into the load score, though guest-scope keeps a guest off
// /dashboard/bills and /dashboard/family-cfo (N13, the bill half of N15). The
// same page labelled an all-time chore ratio "this cycle", and its bill and
// open-chore figures came from unbounded row reads PostgREST caps at 1,000
// (N20). The assistant's proactive context read the same bundle for nobody, so
// a guest's prompt carried a stress score the bills had raised (N13's sibling).
// Driven through the real page, the real proactive slice and the real signals
// over the in-memory database.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import type { SliceEnv } from '@/lib/ai/context/policy';
import { createInMemorySupabase, type Row } from './helpers/in-memory-supabase';

type DB = SupabaseClient<Database>;
const FAMILY = 'f1';
const NOW = '2026-10-14T10:00:00Z';
const h = vi.hoisted(() => ({ db: null as unknown, role: 'parent' }));

const ctx = () => ({
  user: { id: `u-${h.role}` },
  active: {
    familyId: FAMILY, role: h.role,
    member: { id: `m-${h.role}`, display_name: h.role, role: h.role },
    family: { id: FAMILY, name: 'Family', timezone: 'UTC', created_at: '2026-01-01T00:00:00Z' },
  },
});

vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ctx() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { getMessages: messages, translate: tr } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => tr(messages('en-US'), key, params) };
});
vi.mock('@/lib/calendar/source-capability', () => ({ get CALENDAR_SOURCE_ARCHIVE_ENABLED() { return false; } }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: React.ComponentProps<'a'>) => React.createElement('a', props, children) }));

const { default: FamilyReportsPage } = await import('@/app/(app)/family/reports/page');
const { gatherSignalsResult } = await import('@/lib/family/signals');
const { proactiveSlice } = await import('@/lib/ai/context/slices/proactive');

let db: ReturnType<typeof createInMemorySupabase<DB>>;
const bill = (n: number, extra: Row = {}): Row => ({ id: `bill-${String(n).padStart(5, '0')}`, family_id: FAMILY, status: 'paid', due_date: '2026-10-01', ...extra });

async function reportFor(role: string): Promise<string> {
  h.role = role;
  return renderToStaticMarkup(await FamilyReportsPage() as ReactElement).replace(/&#x27;|&#39;/g, "'");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase<DB>({ maxRows: 1000, rpc: { ensure_default_grocery_list: () => 'list-1' } });
  db.seed('families', [{ id: FAMILY, name: 'Family', timezone: 'UTC' }]);
  // Overdue and due-this-week bills: enough to raise the load score on their own.
  db.seed('bills', [
    ...[1, 2, 3, 4, 5, 6].map((n) => bill(n, { status: 'overdue', due_date: '2026-10-01' })),
    bill(7, { status: 'upcoming', due_date: '2026-10-16' }), bill(8), bill(9),
  ]);
  h.db = db;
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('a guest on /family/reports (N13, N15)', () => {
  it('the control: a parent sees the household’s bills', async () => {
    const html = await reportFor('parent');
    expect(html).toContain('Bills due soon');
    expect(html).toContain('2 of 9 tracked bills are paid');
  });

  it('is not shown the bill tile, the bills-paid line or a "0 of 0" in their place', async () => {
    const html = await reportFor('guest');
    expect(html).not.toContain('Bills due soon');
    expect(html).not.toContain('tracked bills are paid');
    expect(html).not.toContain('/dashboard/family-cfo');
  });

  it('gets a load score and actions built without the household’s bills', async () => {
    const parent = await gatherSignalsResult(FAMILY, 'UTC', new Date(NOW), { role: 'parent' });
    const guest = await gatherSignalsResult(FAMILY, 'UTC', new Date(NOW), { role: 'guest' });
    expect(parent.data?.stress.factors.map((f) => f.label)).toContain('Bills due soon');
    expect(guest.data?.stress.factors.map((f) => f.label)).not.toContain('Bills due soon');
    expect(guest.data?.counts).toMatchObject({ billsWithheld: true, overdueBills: 0, billsDueSoon: 0, billsPaid: 0, billsTotal: 0 });
    expect(JSON.stringify(guest.data?.actions)).not.toMatch(/bill/i);
    // Nothing was read: the withheld rows never reached the server's answer.
    const billReads = db.log.filter((entry) => entry.table === 'bills');
    expect(billReads.length).toBeGreaterThan(0); // the parent's
    db.log.length = 0;
    await gatherSignalsResult(FAMILY, 'UTC', new Date(NOW), { role: 'guest' });
    expect(db.log.filter((entry) => entry.table === 'bills')).toHaveLength(0);
  });

  it('every other member still sees them', async () => {
    for (const role of ['adult', 'teen', 'child', 'caregiver']) {
      expect(await reportFor(role)).toContain('2 of 9 tracked bills are paid');
    }
  });
});

describe('the assistant’s proactive context for a guest (N13)', () => {
  type Built = { data: { stress: { score: number; level: string } | null; counts: Row | null }; lines: string[] };
  async function sliceFor(role: string): Promise<Built> {
    const built = await proactiveSlice.load(
      { db, familyId: FAMILY } as unknown as ServiceScope,
      { tz: 'UTC', now: new Date(NOW), viewer: { role, memberId: `m-${role}`, canManage: role === 'parent' }, members: [], pageContext: null } as unknown as SliceEnv,
    );
    if (!built.ok) throw new Error('the proactive slice did not build');
    return built.data as unknown as Built;
  }

  it('scores the household’s stress without the bills, as /dashboard/family-stress does for a guest', async () => {
    const guest = (await gatherSignalsResult(FAMILY, 'UTC', new Date(NOW), { role: 'guest' })).data!;
    const parent = (await gatherSignalsResult(FAMILY, 'UTC', new Date(NOW), { role: 'parent' })).data!;
    // The control: these bills raise the score on their own.
    expect(parent.stress.score).toBeGreaterThan(guest.stress.score);

    const slice = await sliceFor('guest');
    expect(slice.data.stress).toEqual({ score: guest.stress.score, level: guest.stress.level });
    expect(slice.data.counts).toMatchObject({ billsWithheld: true, overdueBills: 0, billsDueSoon: 0, billsTotal: 0 });
    expect(slice.lines.join('\n')).toContain(`household stress ${guest.stress.level} (${guest.stress.score}/100)`);
  });

  it('every other member’s context keeps the score the bills raise', async () => {
    const parent = (await gatherSignalsResult(FAMILY, 'UTC', new Date(NOW), { role: 'parent' })).data!;
    for (const role of ['parent', 'adult', 'teen', 'child', 'caregiver']) {
      expect((await sliceFor(role)).data.stress).toEqual({ score: parent.stress.score, level: parent.stress.level });
    }
  });
});

describe('the figures on /family/reports (N20)', () => {
  it('does not call an all-time chore ratio "this cycle"', async () => {
    db.seed('chore_assignments', [
      { id: 'c1', family_id: FAMILY, status: 'approved', due_at: '2025-01-01T00:00:00Z' },
      { id: 'c2', family_id: FAMILY, status: 'todo', due_at: null },
    ]);
    const html = await reportFor('parent');
    expect(html).not.toContain('this cycle');
    expect(html).toContain('50% of all tasks ever assigned are done.');
  });

  it('counts every bill and open chore past the 1,000-row cap', async () => {
    db.replace('bills', []);
    db.seed('bills', Array.from({ length: 1205 }, (_, n) => bill(n + 1)));
    db.seed('chore_assignments', Array.from({ length: 1102 }, (_, n) => ({
      id: `chore-${String(n).padStart(5, '0')}`, family_id: FAMILY, status: 'todo', due_at: n < 1050 ? '2026-10-01T00:00:00Z' : '2026-10-14T18:00:00Z',
    })));
    const { data } = await gatherSignalsResult(FAMILY, 'UTC', new Date(NOW), { role: 'parent' });
    expect(data?.counts).toMatchObject({ billsTotal: 1205, billsPaid: 1205, openTasks: 1102, overdueTasks: 1050, dueTodayTasks: 52 });
    expect(await reportFor('parent')).toContain('1205 of 1205 tracked bills are paid');
  });
});
