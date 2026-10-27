// The onboarding wizard only renders for a signed-in account (app/onboarding
// /page.tsx sends anyone else to /login), yet every row it wrote to
// `onboarding_events` carried `user_id: null` — the same shape any holder of
// the public anon key can file (0133 accepts `user_id is null`). So the admin
// funnel could not tell a real run from a planted one, and /admin/onboarding
// had no wizard start to time a setup from (N4, N16, N7). Driven through the
// real wizard and the real tracker, writing to the in-memory database.
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { byName, click, render, settle } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';
import { DRAFT_STORAGE_KEY, emptyDraft, serializeDraftState } from '@/lib/onboarding/flow';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));
vi.mock('@/app/onboarding/actions', () => ({ previewCalendarImportAction: vi.fn(), finalizeOnboardingAction: vi.fn() }));
vi.mock('@/app/onboarding/calendar-actions', () => ({ startCalendarConnectionAction: vi.fn(), previewConnectedCalendarAction: vi.fn() }));
vi.mock('@/components/outcomes/do-one-thing-card', () => ({ DoOneThingCard: () => null }));

const { OnboardingWizard } = await import('@/components/onboarding/onboarding-wizard');
const { SOURCE_MESSAGES } = await import('@/lib/i18n/messages');
const { translate } = await import('@/lib/i18n/translate');

const OWNER = { userId: '11111111-1111-4111-8111-111111111111', familyId: null };
let db: ReturnType<typeof createInMemorySupabase>;
let storage: Map<string, string>;
const wizard = () => render(h.hooks, createElement(OnboardingWizard, { expectedOwner: OWNER }));
const events = () => db.table('onboarding_events');

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase();
  h.db = db;
  storage = new Map([[DRAFT_STORAGE_KEY, serializeDraftState('profile', emptyDraft({ name: 'Ada', familyName: 'Ada family', timezone: 'UTC' }), true)]]);
  vi.stubGlobal('window', {});
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('onboarding telemetry names the signed-in account', () => {
  it('records the wizard start as the signed-in user’s', async () => {
    wizard();
    await settle();
    expect(events()).toEqual([expect.objectContaining({ step: 'profile', phase: 'started', user_id: OWNER.userId })]);
  });

  it('records each step the user moves to as theirs', async () => {
    const tree = wizard();
    await settle();
    await click(byName(tree, translate(SOURCE_MESSAGES, 'phoneAuth.continue')));
    wizard();
    await settle();
    expect(events().map((row) => [row.phase, row.user_id])).toEqual([['started', OWNER.userId], ['step', OWNER.userId]]);
  });
});
