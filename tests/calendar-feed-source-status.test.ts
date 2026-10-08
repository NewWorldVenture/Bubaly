import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import en from '@/lib/i18n/messages/en-US.json';
import { translate } from '@/lib/i18n/translate';
import { feedAddedMessage } from '@/lib/calendar/feeds';

const h = vi.hoisted(() => ({ enabled: true, rows: [] as Record<string, unknown>[], sync: vi.fn(), client: vi.fn() }));
const familyId = '22222222-2222-4222-8222-222222222222';
const feed = { id: '11111111-1111-4111-8111-111111111111', family_id: familyId, name: 'Synthetic', url: 'https://synthetic.invalid/feed.ics' };
const t = (key: string, params?: Record<string, string | number>) => translate(en, key, params);
vi.mock('@/lib/calendar/source-capability', () => ({ get CALENDAR_SOURCE_ARCHIVE_ENABLED() { return h.enabled; } }));
vi.mock('@/lib/server/calendar-feeds', () => ({ SYNCING_STATUS: 'syncing', syncFeed: h.sync }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/supabase/server', () => ({ createServer: h.client, createServiceClient: h.client }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ({ user: { id: 'synthetic-user' }, active: { familyId, family: { created_at: '2026-10-01T00:00:00Z' } } }) }));
vi.mock('@/lib/analytics/activation-server', () => ({ recordActivationServer: async () => {} }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => t }));
vi.mock('@/components/i18n/locale-provider', () => ({ useTranslations: () => t }));
vi.mock('@/components/i18n/use-format', () => ({ useFormat: () => ({ fmtDate: () => 'Oct8' }) }));
vi.mock('@/components/app/app-context', () => ({ useApp: () => ({ familyId, userId: 'synthetic-user' }) }));
vi.mock('@/lib/hooks/use-realtime-query', () => ({ useRealtimeQuery: () => ({ data: h.rows, loading: false, error: null, refresh: () => {} }) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: () => {}, error: () => {} }) }));
vi.mock('@/components/ui/confirm', () => ({ useConfirm: () => () => false }));
import { CalendarSyncPanel } from '@/components/dashboard/calendar-sync-panel';
import { addCalendarFeed, syncCalendarFeed } from '@/app/(app)/dashboard/sync/feeds/actions';
import { GET } from '@/app/api/cron/calendar-feeds/route';

function sdk() {
  return createClient('https://synthetic.invalid', 'synthetic-key', { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (input, init) => {
    const url = new URL(String(input));
    expect(url.pathname).toBe('/rest/v1/calendar_feeds');
    expect(init?.method ?? 'GET').toBe('GET');
    const single = new Headers(init?.headers).get('accept')?.includes('vnd.pgrst.object');
    return Response.json(single ? feed : [feed], { headers: { 'content-range': '0-0/1' } });
  } } });
}

beforeEach(() => {
  h.enabled = true;
  h.sync.mockReset().mockResolvedValue({ ok: true, imported: 0, sourceGroups: 2 });
  h.client.mockReset().mockImplementation(sdk);
  h.rows = [{ ...feed, last_status: 'ok', last_synced_at: '2026-10-08T00:00:00Z', last_error: null, event_count: 0 }];
});

describe('source archive status and native counts remain distinct through actual consumers', () => {
  it('actual panel renders a revision-review error instead of green success', () => {
    Object.assign(h.rows[0], { last_status: 'revision_review', last_error: 'Source revisions need review' });
    const html = renderToStaticMarkup(createElement(CalendarSyncPanel));
    expect(html).toContain('Source revisions need review');
    expect(html).toContain('text-danger');
    expect(html).not.toContain('text-success');
    expect(html).not.toContain('0 events');
  });

  it('source success displays localized completion without claiming an event count', () => {
    const html = renderToStaticMarkup(createElement(CalendarSyncPanel));
    expect(html).toContain('Done');
    expect(html).not.toContain('0 events');
    expect(feedAddedMessage({ imported: 0, sourceGroups: 2 }, t)).toBe('Done');
    expect(feedAddedMessage({ imported: 0, sourceGroups: 0 }, t)).toBe('Done');
  });

  it('native disabled rendering and added-event copy preserve their existing counts', () => {
    h.enabled = false;
    h.rows[0].event_count = 7;
    expect(renderToStaticMarkup(createElement(CalendarSyncPanel))).toContain('7 events');
    expect(feedAddedMessage({ imported: 7 }, t)).toBe('Added — 7 events imported');
  });

  it('manual sync action preserves source metadata after its actual SDK family-scoped lookup', async () => {
    expect(await syncCalendarFeed(feed.id)).toEqual({ ok: true, imported: 0, sourceGroups: 2 });
    expect(h.sync).toHaveBeenCalledTimes(1);
  });

  it('re-adding an existing subscription preserves source metadata and its original name', async () => {
    expect(await addCalendarFeed({ name: 'Ignored rename', url: feed.url })).toEqual({ ok: true, imported: 0, sourceGroups: 2, alreadySubscribedAs: 'Synthetic' });
  });

  it('native action return shape remains unchanged', async () => {
    h.sync.mockResolvedValue({ ok: true, imported: 7 });
    expect(await syncCalendarFeed(feed.id)).toEqual({ ok: true, imported: 7 });
  });

  it('cron reports archived UID groups separately from zero native writes', async () => {
    const response = await GET(new NextRequest('https://synthetic.invalid/api/cron/calendar-feeds'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, feeds: 1, synced: 1, imported: 0, failed: 0, busy: 0, sourceGroups: 2 });
  });

  it('cron keeps review-held archives counted without reporting successful display readiness', async () => {
    h.sync.mockResolvedValue({ ok: false, error: 'Review held', revisionReview: true, sourceGroups: 2 });
    const response = await GET(new NextRequest('https://synthetic.invalid/api/cron/calendar-feeds'));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ ok: false, feeds: 1, synced: 0, imported: 0, failed: 1, busy: 0, sourceGroups: 2 });
  });

  it('native cron response shape remains unchanged', async () => {
    h.sync.mockResolvedValue({ ok: true, imported: 7 });
    const response = await GET(new NextRequest('https://synthetic.invalid/api/cron/calendar-feeds'));
    expect(await response.json()).toEqual({ ok: true, feeds: 1, synced: 1, imported: 7, failed: 0, busy: 0 });
  });
});
