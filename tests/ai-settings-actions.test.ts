// Settings → Bubaly AI, the server half. What matters here is that the actions
// are a thin skin over the service: the manager check and the validation must
// not be reimplemented (or forgotten) in the action layer, and a save must
// invalidate the pages that describe what Bubaly will do.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AI_SETTINGS } from '@/lib/ai/family-settings';

const ctx = vi.hoisted(() => ({
  user: { id: 'auth-1', email: 'parent@example.com' },
  memberships: [],
  active: {
    familyId: 'fam-1',
    family: { id: 'fam-1', name: 'The Riveras', timezone: 'America/New_York' },
    role: 'parent' as string,
    member: { id: 'member-1', family_id: 'fam-1', user_id: 'auth-1' },
  },
}));

const mocks = vi.hoisted(() => ({
  loadAISettings: vi.fn(),
  // The gate's FORGIVING read. The page must not use it; it is provided (and
  // answers the defaults, which is what it does when the row cannot be read)
  // so that an action that went back to it would answer `ok: true` with those
  // defaults and FAIL below — rather than throw on a missing mock export and
  // land in the catch that returns the very sentence the test expects.
  getAISettings: vi.fn(),
  updateAISettings: vi.fn(),
  revalidatePath: vi.fn(),
  requireUserContext: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => ({}) }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/services/ai-settings', () => ({
  loadAISettings: mocks.loadAISettings,
  getAISettings: mocks.getAISettings,
  updateAISettings: mocks.updateAISettings,
}));

const { loadAISettingsAction, saveAISettingsAction } = await import('@/app/(app)/dashboard/settings/ai-actions');

const SETTINGS = {
  familyId: 'fam-1', enabled: true, behavior: 'execute' as const,
  categoryBehavior: {}, riskOverrides: {}, childChannels: {}, memoryEnabled: true, quietHours: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUserContext.mockResolvedValue(ctx);
  mocks.loadAISettings.mockResolvedValue({ ok: true, data: SETTINGS });
  mocks.getAISettings.mockResolvedValue({ familyId: 'fam-1', ...DEFAULT_AI_SETTINGS });
  mocks.updateAISettings.mockResolvedValue({ ok: true, data: { ...SETTINGS, behavior: 'prepare' } });
});

describe('loadAISettingsAction', () => {
  it('answers the family’s settings under the caller’s own scope', async () => {
    const res = await loadAISettingsAction();
    expect(res).toEqual({ ok: true, settings: SETTINGS });
    expect(mocks.loadAISettings).toHaveBeenCalledWith(expect.objectContaining({ familyId: 'fam-1', memberId: 'member-1', role: 'parent' }));
  });

  it('does not leak an internal failure to the page', async () => {
    mocks.requireUserContext.mockRejectedValue(new Error('supabase down: postgres://user:pw@host'));
    const res = await loadAISettingsAction();
    expect(res).toEqual({ ok: false, error: 'Could not load your Bubaly settings.' });
  });

  it('answers an error, not the settings, when the service could not read them', async () => {
    // The service's own sentence may carry more than the page should; the page
    // gets the same one a thrown failure gets.
    mocks.loadAISettings.mockResolvedValue({ ok: false, error: 'relation "family_ai_settings" does not exist', code: 'db' });
    const res = await loadAISettingsAction();
    expect(res).toEqual({ ok: false, error: 'Could not load your Bubaly settings.' });
    // It asked the strict read and took its answer — it did not fall back to the
    // forgiving read, whose defaults would have been shown as this family's.
    expect(mocks.loadAISettings).toHaveBeenCalledTimes(1);
    expect(mocks.getAISettings).not.toHaveBeenCalled();
  });
});

describe('saveAISettingsAction', () => {
  it('passes the patch to the service and revalidates what it changes', async () => {
    const res = await saveAISettingsAction({ behavior: 'prepare' });
    expect(res).toMatchObject({ ok: true, settings: { behavior: 'prepare' } });
    expect(mocks.updateAISettings).toHaveBeenCalledWith(expect.objectContaining({ familyId: 'fam-1' }), { behavior: 'prepare' });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/dashboard/settings');
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/dashboard/concierge');
  });

  it('reports the service’s refusal verbatim and revalidates nothing', async () => {
    // The refusal a child gets is the service's, not a second copy of the rule.
    mocks.updateAISettings.mockResolvedValue({ ok: false, error: 'Only a parent or adult can change what Bubaly may do.', code: 'denied' });
    const res = await saveAISettingsAction({ behavior: 'execute' });
    expect(res).toEqual({ ok: false, error: 'Only a parent or adult can change what Bubaly may do.' });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
