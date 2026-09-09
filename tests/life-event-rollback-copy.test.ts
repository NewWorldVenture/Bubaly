import { beforeEach, describe, expect, it, vi } from 'vitest';
import { launchLifeEventAction } from '@/app/(app)/dashboard/life-event-actions';
import { getMessages, getRawMessages, translate } from '@/lib/i18n/messages';
import type { LocaleCode } from '@/lib/i18n/locales';

const harness = vi.hoisted(() => ({ locale: 'en-US' as LocaleCode, launch: vi.fn() }));
vi.mock('@/lib/life-events/launch', () => ({
  LIFE_EVENT_ROLLBACK_INCOMPLETE: 'life_event_rollback_incomplete',
  launchLifeEvent: harness.launch,
}));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ({
  user: { id: 'user-1' },
  active: { familyId: 'family-1', role: 'parent', member: { id: 'member-1' }, family: { timezone: 'UTC' } },
}) }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => ({}) }));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string) => translate(getMessages(harness.locale), key),
}));

beforeEach(() => { harness.launch.mockReset(); harness.locale = 'en-US'; });

describe('incomplete life-event cleanup reaches the family', () => {
  it.each<LocaleCode>(['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'])('reports the cleanup failure in %s without a success result', async (locale) => {
    harness.locale = locale;
    harness.launch.mockResolvedValue({ ok: false, code: 'life_event_rollback_incomplete', error: 'Internal cleanup failure', retryable: false });
    const result = await launchLifeEventAction('moving', '2026-05-01');
    const expected = getRawMessages(locale)['lifeEventActions.rollbackIncomplete'];
    expect(expected).toBeTruthy();
    expect(result).toEqual({ ok: false, error: expected });
    expect(result.created).toBeUndefined();
    expect(result.planId).toBeUndefined();
    expect(harness.launch).toHaveBeenCalledWith(expect.objectContaining({ familyId: 'family-1', userId: 'user-1' }), { templateKey: 'moving', eventDate: '2026-05-01' });
  });

  it('keeps an ordinary failure separate from incomplete cleanup', async () => {
    harness.launch.mockResolvedValue({ ok: false, code: 'db', error: 'Could not start that playbook.' });
    expect(await launchLifeEventAction('moving')).toEqual({ ok: false, error: 'Could not start that playbook.' });
  });
});
