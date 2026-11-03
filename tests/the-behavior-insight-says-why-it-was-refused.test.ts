import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { byName, click, has, render } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// The Behavior page's "AI parenting insight" card (Generate) read only
// `insight` and `tips` from /api/behavior/insight and never looked at the
// status. Every refusal the route answers with a reason — the Free plan's
// monthly AI allowance used up (429), too many requests (429), the behaviour
// log unreadable (503) — came back as `insight: ''`: the spinner stopped and
// the card stayed blank, so the parent could not tell a refusal from a coach
// with nothing to say, and pressed Generate again into the same refusal.
//
// Driven through the REAL module (tests/helpers/module-harness.tsx) with the
// route's answers stubbed at fetch.

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', async () => (await import('./helpers/module-harness')).realtimeQueryModule(h));
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/avatar', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ai/ai-insight', async () => (await import('./helpers/module-harness')).ui);
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));

const { BehaviorModule } = await import('@/components/modules/behavior-module');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
const FAMILY = h.app.familyId;
const screen = () => render(h.hooks, createElement(BehaviorModule));
const answer = vi.fn<() => Response>();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T15:00:00Z'));
  resetHookSlots(h.hooks);
  h.db = createInMemorySupabase();
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.confirmAnswer = true; h.timeZone = 'UTC';
  h.app.members = [
    { id: 'member-1', display_name: 'Ada', role: 'parent', is_active: true, color: null, birthday: null },
    { id: 'kid', display_name: 'Kit', role: 'child', is_active: true, color: null, birthday: null },
  ];
  h.app.selfMember = { ...h.app.members[0], family_id: FAMILY };
  h.app.family = { id: FAMILY, name: 'Fixture family', timezone: 'UTC' };
  (h.app as Record<string, unknown>).role = 'parent';
  answer.mockReset();
  vi.stubGlobal('fetch', vi.fn(async () => answer()));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('the behavior insight card says why it was refused', () => {
  it('the monthly AI allowance used up is said, not shown as a blank insight', async () => {
    const used = 'Your family has used this month\'s 10 AI requests.';
    answer.mockReturnValue(reply(429, { error: used, code: 'allowance_exceeded', limit: 10 }));

    await click(byName(screen(), t('behavior.generate')));

    expect(has(screen(), used)).toBe(true);
  });

  it('an unreadable behaviour log is said, not shown as a blank insight', async () => {
    answer.mockReturnValue(reply(503, { error: t('insight.behaviorDataUnavailable') }));

    await click(byName(screen(), t('behavior.generate')));

    expect(has(screen(), t('insight.behaviorDataUnavailable'))).toBe(true);
  });

  it('a refusal with no reason of its own says the AI is unavailable', async () => {
    answer.mockReturnValue(reply(500, {}));

    await click(byName(screen(), t('behavior.generate')));

    expect(has(screen(), t('aiInsight.aiIsUnavailableRightNow'))).toBe(true);
  });

  it('a refusal is never shown as the coach\'s insight, even if it carries one', async () => {
    answer.mockReturnValue(reply(429, { error: t('insight.tooManyBehaviorInsightRequests'), insight: 'Mostly positive lately.', tips: ['Catch one good moment.'] }));

    await click(byName(screen(), t('behavior.generate')));

    const after = screen();
    expect(has(after, t('insight.tooManyBehaviorInsightRequests'))).toBe(true);
    expect(has(after, 'Mostly positive lately.')).toBe(false);
    expect(has(after, 'Catch one good moment.')).toBe(false);
  });

  it('a real insight is still shown with its tips', async () => {
    answer.mockReturnValue(reply(200, { insight: 'Kit is having a kind week.', tips: ['Name the kindness you see.'] }));

    await click(byName(screen(), t('behavior.generate')));

    const after = screen();
    expect(has(after, 'Kit is having a kind week.')).toBe(true);
    expect(has(after, 'Name the kindness you see.')).toBe(true);
  });
});
