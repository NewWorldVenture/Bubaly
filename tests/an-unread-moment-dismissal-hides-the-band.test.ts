// F38 — /dashboard/moments read the day's dismissals and dropped the read's
// error. A failed read left `dismissed` empty, so every moment the family had
// dismissed today — which dismissMomentAction promises stays quiet for the rest
// of the day — came back in the "Right now" band, with nothing logged. The
// page's own comment says a hiccup hides the band; now it does.
//
// Rendered through the real page, as tests/a-dismissed-moment-is-quiet-for-the-familys-day.test.ts
// renders it, with the Emergency card as the subject (`activeMoments` always
// offers it, so the case does not depend on the clock).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createInMemorySupabase, withFaults } from './helpers/in-memory-supabase';

const FAMILY = 'fam-1';
const EMERGENCY = 'Always one tap away';

const mocks = vi.hoisted(() => ({ requireUserContext: vi.fn(), createServer: vi.fn(), loadScheduleIntelligence: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/schedule/intelligence-server', () => ({ loadScheduleIntelligence: mocks.loadScheduleIntelligence }));
vi.mock('@/components/moments/moments-view', () => ({ MomentsView: () => null }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: () => {}, error: () => {}, info: () => {}, show: () => {} }) }));
vi.mock('@/components/i18n/locale-provider', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => ({ code: 'en-US' }),
  useFamilyTimeZone: () => undefined,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {}, back: () => {} }),
  usePathname: () => '/dashboard/moments',
  useSearchParams: () => new URLSearchParams(),
}));

const MomentsPage = (await import('@/app/(app)/dashboard/moments/page')).default;

let db: ReturnType<typeof createInMemorySupabase>;
let failDismissals: boolean;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-21T15:00:00Z'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase({ uniques: { moment_activations: [['family_id', 'moment_key', 'as_of_date']] } });
  db.seed('moment_activations', [{ id: 'a1', family_id: FAMILY, moment_key: 'emergency', as_of_date: '2026-09-21', status: 'dismissed' }]);
  failDismissals = false;
  // Only the page's READ of the day's activations fails; the log-back upsert is left alone.
  mocks.createServer.mockResolvedValue(withFaults(db, (table, calls) => (
    failDismissals && table === 'moment_activations' && calls[0]?.method === 'select' ? { message: 'canceling statement due to statement timeout' } : null)));
  mocks.loadScheduleIntelligence.mockResolvedValue({ ok: true, data: { departures: {} } });
  mocks.requireUserContext.mockResolvedValue({
    user: { id: 'user-1', email: 'parent@example.com' }, memberships: [],
    active: { familyId: FAMILY, family: { id: FAMILY, timezone: 'UTC' }, role: 'parent', member: { id: 'mem-1' } },
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const open = async () => renderToStaticMarkup((await MomentsPage()) as React.ReactElement);

describe('a moment dismissal that could not be read', () => {
  it('the band shows the card when nothing was dismissed (so its absence below means something)', async () => {
    db.replace('moment_activations', []);
    expect(await open()).toContain(EMERGENCY);
  });

  it('a moment dismissed today stays quiet when the read works', async () => {
    expect(await open()).not.toContain(EMERGENCY);
  });

  it('does not bring today\'s dismissed moments back, and says why in the log', async () => {
    failDismissals = true;
    expect(await open()).not.toContain(EMERGENCY);
    expect(console.error).toHaveBeenCalledWith('[moments] dismissal read failed', expect.objectContaining({ familyId: FAMILY }));
  });
});
