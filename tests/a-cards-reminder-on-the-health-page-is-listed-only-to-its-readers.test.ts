import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { getMessages, translate } from '@/lib/i18n/messages';
import { createInMemorySupabase, withFaults } from './helpers/in-memory-supabase';

// FL-R3-A. The scan executes an insurance card itself a few days out and
// leaves a `reminders` row behind — "Renew dental insurance (Smile Co)" for
// Ava's policy, unassigned so the managers who renew it are reminded. The
// Health page's "Health Reminders" card read `reminders` with no audience
// check, so Kit (a child the policy does not name), a teen, a caregiver and a
// guest were each listed it.
//
// The card now keeps a card's reminder within the card's readers
// (lib/autopilot/reminder-cards.ts): the managers and Ava. Driven through the
// real scan and the real HealthModule over the in-memory database: its
// reminder read is run as the module runs it in the reader's browser, and the
// page is rendered with what that read returned.

type DB = SupabaseClient<Database>;
type Memory = ReturnType<typeof createInMemorySupabase<DB>>;
type Query = { table: string; fetcher: (sb: unknown) => PromiseLike<{ data: unknown[] | null; error: unknown }> };

const FAMILY = 'f1';
const ROSTER = [
  { id: 'mum', role: 'parent' }, { id: 'gran', role: 'adult' }, { id: 'sitter', role: 'caregiver' },
  { id: 'sam', role: 'teen' }, { id: 'ava', role: 'child' }, { id: 'kit', role: 'child' }, { id: 'neighbour', role: 'guest' },
];
const member = (id: string) => ({
  id, family_id: FAMILY, user_id: `u-${id}`, display_name: id, role: ROSTER.find((m) => m.id === id)!.role,
  color: '#336699', is_active: true, birthday: null, avatar_url: null, updated_at: '2026-09-01T00:00:00Z',
});

const h = vi.hoisted(() => ({
  viewer: { role: 'guest', memberId: 'neighbour' },
  queries: [] as { table: string; fetcher: (sb: unknown) => PromiseLike<{ data: unknown[] | null; error: unknown }> }[],
  rows: {} as Record<string, unknown[]>,
}));

vi.mock('@/components/app/app-context', () => ({
  useApp: () => {
    const self = { id: h.viewer.memberId, family_id: 'f1', user_id: `u-${h.viewer.memberId}`, display_name: h.viewer.memberId, role: h.viewer.role, is_active: true };
    return { familyId: 'f1', userId: `u-${h.viewer.memberId}`, role: h.viewer.role, members: [self], selfMember: self, isSuperAdmin: false, planLevel: 2, featureTiers: {} };
  },
}));
// The module's reads, handed over to be run against the database; the page is
// then rendered with what each read returned.
vi.mock('@/lib/hooks/use-realtime-query', () => ({
  useRealtimeQuery: (config: { table: string; fetcher: (sb: unknown) => PromiseLike<{ data: unknown[] | null; error: unknown }> }) => {
    h.queries.push({ table: config.table, fetcher: config.fetcher });
    return { data: h.rows[config.table] ?? [], error: null, loading: false, stale: false, refresh: () => {} };
  },
}));
vi.mock('@/components/i18n/locale-provider', async (importOriginal) => {
  const { localeOrDefault } = await import('@/lib/i18n/locales');
  return {
    ...(await importOriginal<typeof import('@/components/i18n/locale-provider')>()),
    useFamilyTimeZone: () => 'UTC',
    useLocale: () => localeOrDefault('en-US'),
    useTranslations: () => (key: string, params?: Record<string, string | number>) => translate(getMessages('en-US'), key, params),
  };
});
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: () => {}, error: () => {} }) }));
vi.mock('@/components/ui/confirm', () => ({ useConfirm: () => async () => true }));
vi.mock('@/components/ui/modal', () => ({ Modal: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? createElement('section', null, children) : null) }));
vi.mock('@/components/app/page-header', () => ({ PageHeader: () => null }));
// The scan's own push and the activity trail are not what is under test.
vi.mock('@/lib/services/activity', () => ({ recordActivitySafely: vi.fn() }));
vi.mock('@/lib/services/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/notifications')>()),
  notify: vi.fn(async () => ({ ok: true, data: { created: 1 } })),
}));

const { runAutopilotScan } = await import('@/lib/autopilot/scan');
const { HealthModule } = await import('@/components/modules/health-module');

const POLICY = 'Renew dental insurance (Smile Co)';
const echo = (key: string, params?: Record<string, string | number>) => `${key} ${JSON.stringify(params ?? {})}`;
const as = (memberId: string) => { h.viewer = { role: ROSTER.find((m) => m.id === memberId)!.role, memberId }; };

/** Ava's dental policy renews in three days: the scan reminds the family of it itself. */
async function scannedHousehold(): Promise<Memory> {
  const db = createInMemorySupabase<DB>({
    uniques: { autopilot_suggestions: [['family_id', 'dedupe_key']] },
    defaults: { reminders: { is_done: false, notes: null, recurrence: 'none' } },
    rpc: { ensure_default_grocery_list: () => 'list-1' },
  });
  db.seed('families', [{ id: FAMILY, timezone: 'UTC', name: 'Family' }]);
  db.seed('family_members', ROSTER.map((m) => member(m.id)));
  db.seed('family_insurance_policies', [{ id: 'pol-ava', family_id: FAMILY, policy_type: 'dental', insurer: 'Smile Co', renewal_date: '2026-10-01', member_id: 'ava', is_active: true }]);
  vi.setSystemTime(new Date('2026-09-28T06:30:00Z'));
  await runAutopilotScan(db, FAMILY, null, 'UTC', 'en-US', echo, new Date('2026-09-28T06:30:00Z'));
  expect(db.table('autopilot_suggestions').find((s) => s.source_id === 'pol-ava')).toMatchObject({ status: 'auto_executed', kind: 'insurance', member_id: 'ava' });
  expect(db.table('reminders')).toEqual([expect.objectContaining({ title: POLICY, member_id: null, related_type: 'renewal', related_id: 'pol-ava', is_done: false })]);
  vi.setSystemTime(new Date('2026-09-28T08:00:00Z'));
  return db;
}

/** The Health page as `memberId` sees it: the titles its reminder read returned, and the "Health Reminders" card. */
async function healthReminders(memberId: string, db: unknown) {
  as(memberId);
  h.queries = [];
  h.rows = {};
  renderToStaticMarkup(createElement(HealthModule));
  const query = h.queries.find((q: Query) => q.table === 'reminders');
  if (!query) throw new Error('the Health page did not read its reminders');
  const { data, error } = await query.fetcher(db);
  expect(error).toBeNull();
  h.rows = { reminders: data ?? [] };
  const html = renderToStaticMarkup(createElement(HealthModule));
  const heading = translate(getMessages('en-US'), 'health.healthReminders');
  const at = html.indexOf(`>${heading}</h2>`);
  expect(at, 'the Health Reminders card was not rendered').toBeGreaterThan(-1);
  const next = html.indexOf('<h2', at + 1);
  const card = html.slice(at, next === -1 ? undefined : next);
  return { titles: ((data ?? []) as { title: string }[]).map((r) => r.title).sort(), card };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("the Health page's reminders card lists the scan's insurance reminder only to its card's readers", () => {
  it('mum, gran and Ava are listed it; Kit, a teen, a caregiver and a guest are not', async () => {
    const db = await scannedHousehold();
    for (const reader of ['mum', 'gran', 'ava']) {
      const seen = await healthReminders(reader, db);
      expect(seen.titles, reader).toEqual([POLICY]);
      expect(seen.card, reader).toContain(POLICY);
    }
    for (const reader of ['kit', 'sam', 'sitter', 'neighbour']) {
      const seen = await healthReminders(reader, db);
      expect(seen.titles, reader).toEqual([]);
      expect(seen.card, reader).not.toContain(POLICY);
      expect(seen.card, reader).toContain(translate(getMessages('en-US'), 'health.noActiveReminders'));
    }
  });

  it('a reminder somebody wrote is listed to everyone as before, four at most', async () => {
    const db = await scannedHousehold();
    db.seed('reminders', ['Book the eye test', 'Refill the inhaler', 'Flu jab', 'Dentist forms', 'Vitamins'].map((title, i) => ({
      id: `rem-${i}`, family_id: FAMILY, title, remind_at: `2026-10-0${i + 2}T09:00:00Z`, member_id: null, is_done: false, related_type: null, related_id: null, notes: null, recurrence: 'none',
    })));
    for (const reader of ['kit', 'neighbour']) {
      const seen = await healthReminders(reader, db);
      expect(seen.titles, reader).toHaveLength(4);
      expect(seen.titles, reader).not.toContain(POLICY);
    }
    const mum = await healthReminders('mum', db);
    expect(mum.titles).toHaveLength(4);
  });

  it("Kit is still listed four of the reminders that are Kit's when the card's reminder is among the first four read", async () => {
    const db = await scannedHousehold();
    db.seed('reminders', ['Book the eye test', 'Refill the inhaler', 'Flu jab', 'Dentist forms'].map((title, i) => ({
      id: `rem-${i}`, family_id: FAMILY, title, remind_at: `2026-10-0${i + 2}T09:00:00Z`, member_id: null, is_done: false, related_type: null, related_id: null, notes: null, recurrence: 'none',
    })));
    const kit = await healthReminders('kit', db);
    expect(kit.titles).toEqual(['Book the eye test', 'Dentist forms', 'Flu jab', 'Refill the inhaler']);
  });

  it('a failed read of the cards lists it to the managers alone', async () => {
    const db = await scannedHousehold();
    const faulty = withFaults(db, (table, calls) => (table === 'autopilot_suggestions' && calls.some((c) => c.method === 'or') ? { message: 'Fixture read refused' } : null));
    expect((await healthReminders('mum', faulty)).titles).toEqual([POLICY]);
    for (const reader of ['ava', 'kit']) expect((await healthReminders(reader, faulty)).titles, reader).toEqual([]);
    expect(console.error).toHaveBeenCalledWith('[health] autopilot reminder cards read failed', expect.anything());
  });
});
