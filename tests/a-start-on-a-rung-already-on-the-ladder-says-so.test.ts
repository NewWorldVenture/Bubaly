import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { LADDER } from '@/lib/independence/progression';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { byName, click, render } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// F18 follow-up. "Start" became insert-only so a stale page could not set an
// achieved rung back to in progress — but it still answered { ok: true } when
// the insert was ignored, so the page toasted "Added “…” to Kit's ladder." for
// a rung that was already there (achieved, even), audited a start that never
// happened, and kept offering Start.
//
// The real action against an in-memory database that applies the unique key
// the upsert names; and the real module, as a parent taps Start.

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const state = vi.hoisted(() => ({
  db: null as unknown,
  audits: [] as unknown[],
  refresh: vi.fn(),
  start: vi.fn(),
}));

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: state.refresh, push: () => {} }) }));
// The module's import of the action; the action itself is driven for real below.
vi.mock('@/app/(app)/dashboard/independence/actions', () => ({ startMilestoneAction: state.start, achieveMilestoneAction: vi.fn(), skipMilestoneAction: vi.fn() }));

vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'user-1' }, active: { familyId: 'family-1', role: 'parent' } }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => state.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES: messages } = await import('@/lib/i18n/messages');
  const { translate: tr } = await import('@/lib/i18n/translate');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => tr(messages, key, params) };
});
vi.mock('@/lib/server/audit', () => ({ logAudit: async (_db: unknown, payload: unknown) => { state.audits.push(payload); } }));

const { startMilestoneAction } = await vi.importActual<typeof import('@/app/(app)/dashboard/independence/actions')>('@/app/(app)/dashboard/independence/actions');
const { IndependenceModule } = await import('@/components/modules/independence-module');

const t = (key: string) => translate(SOURCE_MESSAGES, key);
const FAMILY = 'family-1';
const RUNG = LADDER[0];
const ALREADY = { ok: false, code: 'alreadyOnLadder', error: t('actions.milestoneAlreadyOnTheLadder') };
let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;

beforeEach(() => {
  db = createInMemorySupabase<SupabaseClient<Database>>({ uniques: { independence_milestones: [['family_id', 'member_id', 'domain', 'title']] } });
  db.seed('family_members', [{ id: 'kid', family_id: FAMILY, display_name: 'Kit', role: 'child', is_active: true }]);
  state.db = db;
  state.audits = [];
  state.refresh.mockReset();
  state.start.mockReset();
  resetHookSlots(h.hooks);
  h.toasts = { success: [], error: [] };
});
afterEach(() => { vi.restoreAllMocks(); });

describe('the action says when the rung was already on the ladder', () => {
  it('a first Start adds the rung; a second is answered "already on the ladder", writes nothing and audits nothing', async () => {
    expect(await startMilestoneAction('kid', RUNG.title)).toEqual({ ok: true });
    expect(db.table('independence_milestones')).toEqual([expect.objectContaining({ member_id: 'kid', title: RUNG.title, status: 'in_progress' })]);
    expect(state.audits).toHaveLength(1);

    expect(await startMilestoneAction('kid', RUNG.title)).toEqual(ALREADY);
    expect(db.table('independence_milestones')).toHaveLength(1);
    expect(state.audits).toHaveLength(1);
  });

  it('Start from a stale page on an achieved rung leaves it achieved and says so', async () => {
    db.seed('independence_milestones', [{ id: 'm1', family_id: FAMILY, member_id: 'kid', domain: RUNG.domain, title: RUNG.title, status: 'achieved', achieved_at: '2026-10-01T00:00:00Z', evidence: 'Did it all week' }]);
    expect(await startMilestoneAction('kid', RUNG.title)).toEqual(ALREADY);
    expect(db.table('independence_milestones')).toEqual([expect.objectContaining({ id: 'm1', status: 'achieved', evidence: 'Did it all week' })]);
    expect(state.audits).toEqual([]);
  });

  it('the sentence is in every catalogue the gate checks', () => {
    for (const locale of ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT']) {
      const catalogue = JSON.parse(readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8')) as Record<string, string>;
      expect(catalogue['actions.milestoneAlreadyOnTheLadder'], locale).toEqual(expect.any(String));
    }
  });
});

describe('the ladder page does not celebrate a rung it did not add', () => {
  const kid = { id: 'kid', display_name: 'Kit', role: 'child', birthday: '2018-03-01', color: null };
  const screen = () => render(h.hooks, createElement(IndependenceModule, { kids: [kid], rows: [] }));

  it('"already on the ladder" is shown as such and the page is brought up to date', async () => {
    state.start.mockResolvedValue(ALREADY);
    await click(byName(screen(), 'Start'));
    expect(h.toasts.success).toEqual([]);
    expect(h.toasts.error).toEqual([ALREADY.error]);
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });

  it('a rung it did add is still celebrated, and a refusal still is not', async () => {
    state.start.mockResolvedValue({ ok: true });
    await click(byName(screen(), 'Start'));
    expect(h.toasts.success).toHaveLength(1);
    expect(h.toasts.success[0]).toMatch(/^Added “.+” to Kit's ladder\.$/);
    expect(state.refresh).toHaveBeenCalledTimes(1);

    state.refresh.mockReset();
    h.toasts = { success: [], error: [] };
    state.start.mockResolvedValue({ ok: false, error: 'Refused.' });
    await click(byName(screen(), 'Start'));
    expect(h.toasts).toEqual({ success: [], error: ['Refused.'] });
    expect(state.refresh).not.toHaveBeenCalled();
  });
});
