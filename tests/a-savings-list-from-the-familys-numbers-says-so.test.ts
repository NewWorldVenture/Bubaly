// N15, the remainder — a savings reply that had a summary and no usable
// suggestions was shown with the list computed from the family's own numbers,
// unlabelled: the route answered `source: 'ai'` for the whole thing, and the
// card labels the list only when the source is not the AI. So the family read
// the deterministic list as the AI's own analysis.
//
// The route now says, separately, that the list is the family's own numbers
// (`suggestionsSource: 'fallback'`), and the card labels it. Driven through
// the real savings route over the in-memory database and the real card on the
// hook-slot harness, the card reading what the route answered.
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { byName, click, render, text } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = await vi.hoisted(async () => ({
  ...(await (await import('./helpers/module-state')).createModuleState()),
  db: null as unknown,
  complete: null as unknown as (...args: unknown[]) => Promise<unknown>,
}));

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('@/lib/supabase/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase/auth')>()),
  requireUserContext: async () => ({
    user: { id: USER, email: 'parent@example.test' },
    memberships: [],
    active: { familyId: FAMILY, role: 'parent', member: { id: MEMBER, display_name: 'Dana' }, family: { id: FAMILY, name: 'The Riveras', timezone: 'UTC' } },
  }),
  isSuperAdmin: async () => false,
}));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/ai/provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/provider')>()),
  isAIConfigured: async () => true,
  resolveProvider: async () => ({ complete: (...args: unknown[]) => h.complete(...args) }),
}));

const FAMILY = '00000000-0000-4000-8000-0000000f1501';
const USER = '00000000-0000-4000-8000-0000000f1511';
const MEMBER = '00000000-0000-4000-8000-0000000f1521';

const { POST: savings } = await import('@/app/api/ai/savings/route');
const { SavingsCoachCard } = await import('@/components/modules/savings-coach-card');

const t = (key: string) => translate(SOURCE_MESSAGES, key);
const FROM_THEIR_NUMBERS = t('savingsCoach.fromYourNumbersNotTheAi');
let db: InMemorySupabase;

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase();
  h.db = db;
  db.seed('families', [{ id: FAMILY, name: 'The Riveras', timezone: 'UTC', trial_ends_at: null, closed_at: null }]);
  db.seed('subscriptions', [{ id: 'sub-riveras', family_id: FAMILY, plan: 'plus', status: 'active', current_period_end: '2099-01-01T00:00:00Z' }]);
  db.seed('family_members', [{ id: MEMBER, family_id: FAMILY, user_id: USER, role: 'parent', is_active: true, display_name: 'Dana' }]);
  // What the route answers is what the card is handed.
  vi.stubGlobal('fetch', vi.fn(async () => savings()));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const card = (): ReactNode => render(h.hooks, createElement(SavingsCoachCard));

async function analyse(reply: unknown): Promise<string> {
  h.complete = async () => ({ text: JSON.stringify(reply), model: 'mock-model' });
  await click(byName(card(), t('savingsCoach.analyzeMyFinances')));
  return text(card());
}

describe('the savings card', () => {
  it('labels the list as the family’s own numbers when the AI gave only a summary', async () => {
    const shown = await analyse({ summary: 'Spending is steady this month.', suggestions: [] });

    // The model's summary, and the computed list under the label that says what it is.
    expect(shown).toContain('Spending is steady this month.');
    expect(shown).toContain('On track.');
    expect(shown).toContain(FROM_THEIR_NUMBERS);
  });

  it('control: does not label suggestions the AI wrote itself', async () => {
    const shown = await analyse({ summary: 'Two easy wins.', suggestions: [{ title: 'Pause the gym', detail: 'Unused for two months.' }] });

    expect(shown).toContain('Pause the gym.');
    expect(shown).not.toContain(FROM_THEIR_NUMBERS);
  });
});
