// "Bubaly's comparison" of a home project's quotes, and the assistant's
// `services.compareQuotes`, decided whether a quote had expired on Greenwich's
// day, not the family's.
//
// `compareQuotes` (lib/services/providers/compare.ts) turns a Date into a day
// with `toISOString()`. Its two callers each handed it a Date:
//   - the Projects page handed it the family's day as the date-only helpers
//     want it, LOCAL midnight on the device. East of Greenwich that instant is
//     still the previous day in UTC, so for the whole day after a quote's
//     "valid until" the comparison ranked it as a live offer, often first as
//     the lowest price, while the row under it (lib/projects/planner.ts, which
//     reads the local fields) said "expired" and offered no Accept;
//   - the assistant handed it the current instant, so from late afternoon in
//     the Americas a quote valid until today was "Expired", and in the morning
//     in Asia or Australia yesterday's expired quote was still live.
// Both callers now hand it the family's day key.
//
// The page is driven through tests/helpers/module-harness.tsx with the host
// bound to the family's zone, because the shift only exists on a device east
// of Greenwich and CI runs under UTC and Los Angeles.
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { getTool } from '@/lib/ai/tools/registry';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { HOUSEHOLD_DEFAULTS } from './helpers/household-fixtures';
import { byName, click, has, nodes, render, text } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', async () => (await import('./helpers/module-harness')).realtimeQueryModule(h));
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/ui/confirm', async () => (await import('./helpers/module-harness')).confirmModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ai/ai-insight', async () => (await import('./helpers/module-harness')).ui);
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));

const { ProjectsModule } = await import('@/components/modules/projects-module');

const FAMILY = h.app.familyId;
const PROJECT = 'project-deck';
/** The cheapest quote, valid until the last day of October. */
const LAPSING = 'Lapsing Decks';

function seed(db: { seed: (table: string, rows: Record<string, unknown>[]) => void }) {
  db.seed('home_projects', [{ id: PROJECT, family_id: FAMILY, title: 'Re-stain the deck', status: 'quoting', is_diy: false, updated_at: '2026-10-20T00:00:00Z' }]);
  db.seed('project_quotes', [
    { id: 'q-lapsing', family_id: FAMILY, project_id: PROJECT, contractor_name: LAPSING, amount_cents: 90_000, includes_materials: false, lead_time_days: 5, valid_until: '2026-10-31', status: 'received', notes: null },
    { id: 'q-cedar', family_id: FAMILY, project_id: PROJECT, contractor_name: 'Cedar & Sons', amount_cents: 120_000, includes_materials: true, lead_time_days: 7, valid_until: '2026-12-31', status: 'received', notes: 'two coats' },
    { id: 'q-oak', family_id: FAMILY, project_id: PROJECT, contractor_name: 'Oak Street Pros', amount_cents: 150_000, includes_materials: true, lead_time_days: 3, valid_until: null, status: 'received', notes: null },
  ]);
}

describe('the assistant ranks the quotes on the family\'s day', () => {
  const tool = getTool('services.compareQuotes')!;
  type Out = { ranked: { quote_id: string }[]; excluded: { quote_id: string; reason: string }[] };

  async function compareAt(tz: string, nowIso: string): Promise<Out> {
    const db = createInMemorySupabase<SupabaseClient<Database>>();
    seed(db);
    const scope: ServiceScope = { db, familyId: FAMILY, userId: 'user-1', memberId: 'member-1', role: 'parent', actorKind: 'ai', tz, now: new Date(nowIso) };
    const res = await tool.execute(scope, { project_id: PROJECT });
    expect(res.ok).toBe(true);
    return (res.ok ? res.data : null) as Out;
  }

  it('in Los Angeles at 7:30 pm on 31 October, a quote valid until 31 October is still on offer', async () => {
    const out = await compareAt('America/Los_Angeles', '2026-11-01T02:30:00Z');
    expect(out.ranked.map((r) => r.quote_id)).toContain('q-lapsing');
    expect(out.excluded.map((e) => e.quote_id)).not.toContain('q-lapsing');
  });

  it('in Tokyo at 8:30 am on 1 November, the same quote has expired', async () => {
    const out = await compareAt('Asia/Tokyo', '2026-10-31T23:30:00Z');
    expect(out.ranked.map((r) => r.quote_id)).not.toContain('q-lapsing');
    expect(out.excluded).toContainEqual({ quote_id: 'q-lapsing', contractor_name: LAPSING, reason: 'Expired 2026-10-31' });
  });
});

describe('the Projects page ranks the quotes on the family\'s day, as the rows under the ranking do', () => {
  const HOST_TZ = process.env.TZ;
  /** The host's zone and the family's are the same, as on the family's own phone. */
  function livingIn(tz: string, nowIso: string) {
    process.env.TZ = tz;
    h.timeZone = tz;
    vi.setSystemTime(new Date(nowIso));
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    resetHookSlots(h.hooks);
    const db = createInMemorySupabase({ defaults: HOUSEHOLD_DEFAULTS });
    h.db = db;
    h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
    h.toasts = { success: [], error: [] }; h.confirmAnswer = true;
    seed(db);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    if (HOST_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = HOST_TZ;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const screen = () => render(h.hooks, createElement(ProjectsModule));
  /** The open project's Quotes tab. */
  async function quotesTab(): Promise<ReactNode> {
    await click(byName(screen(), /Re-stain the deck/));
    await click(byName(screen(), /^Quotes/));
    return screen();
  }
  /** "Bubaly's comparison": the ranked list, as the family reads it. */
  const ranking = (tree: ReactNode) => {
    const list = nodes(tree).find((node) => node.type === 'ol');
    if (!list) throw new Error('no ranking on screen');
    return text(list);
  };
  /** The quote's own row, under the ranking. */
  const row = (tree: ReactNode, name: string) => nodes(tree).filter((node) => node.type === 'li' && has(node, name) && has(node, 'valid to')).map(text).join(' ');

  it('in Amsterdam on 1 November, the quote that ran out on 31 October is not in the ranking, and its row says expired', async () => {
    livingIn('Europe/Amsterdam', '2026-11-01T10:00:00Z');
    const tree = await quotesTab();
    expect(row(tree, LAPSING)).toContain('expired');
    expect(ranking(tree)).not.toContain(LAPSING);
    expect(ranking(tree)).toContain('Cedar & Sons');
  });

  it('in Sydney on 1 November, the same', async () => {
    livingIn('Australia/Sydney', '2026-10-31T22:00:00Z');
    const tree = await quotesTab();
    expect(row(tree, LAPSING)).toContain('expired');
    expect(ranking(tree)).not.toContain(LAPSING);
  });

  it('in Los Angeles on the evening of 31 October, it is still ranked and its row is not expired (control)', async () => {
    livingIn('America/Los_Angeles', '2026-11-01T02:30:00Z');
    const tree = await quotesTab();
    expect(row(tree, LAPSING)).not.toContain('expired');
    expect(ranking(tree)).toContain(LAPSING);
  });
});
