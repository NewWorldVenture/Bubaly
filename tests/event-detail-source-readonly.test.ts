import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Tables } from '@/lib/database.types';
const h = vi.hoisted(() => ({ nativeHook: vi.fn(), insight: vi.fn(), schedule: vi.fn() }));
vi.mock('@/lib/supabase/client', () => ({ createClient: vi.fn(() => { throw Error('Unexpected database call during render'); }) }));
vi.mock('@/app/(app)/dashboard/calendar/actions', () => ({ deleteCalendarEventAction: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ error: vi.fn() }) }));
vi.mock('@/components/ui/confirm', () => ({ useConfirm: () => { h.nativeHook(); return vi.fn(); } }));
vi.mock('@/components/ui/modal', () => ({ Modal: ({ children, title }: {children: ReactNode; title: string}) => createElement('section', { 'aria-label': title }, children) }));
vi.mock('@/components/ai/ai-insight', () => ({ AiInsight: () => { h.insight(); return createElement('span', null, 'Native AI'); } }));
vi.mock('@/components/calendar/event-detail', () => ({ EventScheduleInsights: () => { h.schedule(); return createElement('span', null, 'Native schedule'); } }));
vi.mock('@/components/ui/avatar', () => ({ Avatar: () => null }));
vi.mock('@/components/i18n/locale-provider', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/components/i18n/use-format', () => ({ useFormat: () => ({ fmtDate: (value: string) => value, fmtTime: (value: string) => value }) }));
import { EventDetailModal } from '@/components/modules/event-detail-modal';
function render(overrides: Partial<Tables<'calendar_events'>> = {}) {
  const event = { id: 'synthetic-event', title: 'Imported family trip', starts_at: '2026-10-10T12:00:00Z', ends_at: '2026-10-10T13:00:00Z', all_day: false, recurrence: 'none', family_id: 'family', feed_id: null, external_uid: null, location: 'Synthetic location', description: 'Synthetic details', ...overrides } as Tables<'calendar_events'>;
  return renderToStaticMarkup(createElement(EventDetailModal, { event, members: [], selfMemberId: 'member', familyId: 'family', onClose: vi.fn(), onEdit: vi.fn(), onDeleted: vi.fn() }));
}
beforeEach(() => { vi.clearAllMocks(); });
describe('actual imported-event detail rendering boundary', () => {
  it.each([{ feed_id: 'feed' }, { external_uid: 'source-uid' }, { feed_id: 'feed', external_uid: 'source-uid' }])('keeps imported details readable without mounting native actions: %j', origin => {
    const html = render(origin);
    expect(html).toContain('Imported family trip'); expect(html).toContain('Synthetic location'); expect(html).toContain('Synthetic details');
    expect(html).not.toContain('<button'); expect(html).not.toContain('yourRsvp'); expect(html).not.toContain('noRsvpsYet');
    expect(h.nativeHook).not.toHaveBeenCalled(); expect(h.insight).not.toHaveBeenCalled(); expect(h.schedule).not.toHaveBeenCalled();
  });
  it('retains native editing, RSVP and insight controls', () => {
    const html = render(); expect(html).toContain('<button'); expect(html).toContain('yourRsvp'); expect(h.nativeHook).toHaveBeenCalledOnce(); expect(h.insight).toHaveBeenCalledOnce(); expect(h.schedule).toHaveBeenCalledOnce();
  });
  it('retains civil all-day display for an imported event', () => {
    const html = render({ feed_id: 'feed', all_day: true, starts_at: '2026-10-10T00:00:00Z', ends_at: '2026-10-12T00:00:00Z' });
    expect(html).toContain('2026-10-10'); expect(html).toContain('2026-10-11'); expect(html).toContain('calendar.allDay'); expect(h.nativeHook).not.toHaveBeenCalled();
  });
});
