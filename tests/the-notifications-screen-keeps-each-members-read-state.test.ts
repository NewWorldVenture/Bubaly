// The notifications screen, for three findings:
//
// A15 — "Scan for updates" said "You're all caught up — nothing new." about a
//       scan whose reads had failed. The route says `incomplete` now, and the
//       screen says so instead.
// A19 — "Mark all read" marked the shared family-wide rows (user_id NULL) too,
//       and is_read is ONE column: a child's tap cleared them for every parent.
//       A member now marks their own rows; only a manager still marks the
//       shared ones (as only a manager could ever remove them).
// A9  — the bin DELETEd the row, which the generator then re-created. It
//       dismisses through the server action now.
//
// Driven through the real NotificationsModule on hook slots.
import { readFileSync } from 'node:fs';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bodyOf } from './helpers/source-order';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { byName, click, render } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const seams = vi.hoisted(() => ({ dismiss: vi.fn() }));
const Stub = () => null;

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));
vi.mock('@/lib/hooks/use-realtime-query', async () => (await import('./helpers/module-harness')).realtimeQueryModule(h));
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/i18n/use-format', () => ({ useFormat: () => ({ fmtRelative: () => 'now' }) }));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/badge', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ai/ai-insight', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/card', () => ({ Card: ({ children }: { children: ReactNode }) => createElement('section', null, children) }));
vi.mock('@/components/settings/notification-email-preference', () => ({ NotificationEmailPreference: Stub }));
vi.mock('@/app/(app)/dashboard/approvals-actions', () => ({ decideApproval: vi.fn() }));
vi.mock('@/app/(app)/dashboard/chores/actions', () => ({ setChoreStatusAction: vi.fn() }));
vi.mock('@/app/(app)/dashboard/notifications/actions', () => ({ dismissNotificationAction: seams.dismiss }));

const { NotificationsModule } = await import('@/components/modules/notifications-module');
const FAMILY = '0f0f0f0f-0000-4000-8000-000000000001';
let db: ReturnType<typeof createInMemorySupabase>;
const screen = () => render(h.hooks, createElement(NotificationsModule));
const row = (id: string) => db.table('notifications').find((n) => n.id === id)!;
const note = (id: string, user: string | null, title: string) => ({
  id, family_id: FAMILY, user_id: user, type: 'system', title, body: null, related_type: null, related_id: null,
  is_read: false, send_at: '2026-09-30T06:00:00.000Z', created_at: '2026-09-30T06:00:00.000Z',
});

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase();
  h.db = db;
  h.rows = {}; h.toasts = { success: [], error: [] }; h.calls = []; h.fault = null;
  Object.assign(h.app, { familyId: FAMILY, userId: 'u-kid', role: 'child' });
  db.seed('notifications', [
    note('mine', 'u-kid', 'Feed the cat'),
    note('shared', null, 'Anniversary in 3 days'),
    note('parents', 'u-parent', 'Approve the gift'),
  ]);
  seams.dismiss.mockReset().mockResolvedValue({ ok: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('"Mark all read" marks only the reader\'s own notices (A19)', () => {
  it('a child\'s tap leaves the shared family-wide notice unread for the parents', async () => {
    await click(byName(screen(), 'Mark all read'));
    expect(row('mine').is_read).toBe(true);
    expect(row('shared').is_read).toBe(false);
    expect(row('parents').is_read).toBe(false);
  });

  it('a manager still clears the shared one, and never another member\'s (control)', async () => {
    Object.assign(h.app, { userId: 'u-parent', role: 'parent' });
    await click(byName(screen(), 'Mark all read'));
    expect(row('shared').is_read).toBe(true);
    expect(row('parents').is_read).toBe(true);
    expect(row('mine').is_read).toBe(false);
  });
});

describe('the bin dismisses rather than deletes (A9)', () => {
  it('calls the dismissal and leaves the row for the dedupe', async () => {
    await click(byName(screen(), 'Delete: Feed the cat'));
    expect(seams.dismiss).toHaveBeenCalledWith({ id: 'mine' });
    expect(db.table('notifications')).toHaveLength(3);
  });

  it('says so when the dismissal was refused', async () => {
    seams.dismiss.mockResolvedValue({ ok: false, error: 'That change was not saved.' });
    await click(byName(screen(), 'Delete: Anniversary in 3 days'));
    expect(h.toasts.error).toEqual(['That change was not saved.']);
  });
});

describe('"Scan for updates" does not call an incomplete scan "all caught up" (A15)', () => {
  const answer = (body: unknown) => vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })));

  it('an incomplete scan says some updates could not be checked', async () => {
    answer({ created: 0, incomplete: true });
    await click(byName(screen(), 'Scan for updates'));
    expect(h.toasts.error).toEqual(['Some updates could not be checked just now. Please scan again in a moment.']);
    expect(h.toasts.success).toEqual([]);
  });

  it('a complete, quiet scan is still "all caught up" (control)', async () => {
    answer({ created: 0, incomplete: false });
    await click(byName(screen(), 'Scan for updates'));
    expect(h.toasts.success).toEqual(["You're all caught up — nothing new."]);
  });
});

describe('the brief marks only the reader\'s own notices read (A19)', () => {
  // The route's mark-read runs after a model call and a dozen reads; the bound
  // it carries is checked here on its statement.
  it('bounds its mark-read to the reader, and to the shared rows only for a manager', () => {
    const route = readFileSync('app/api/ai/briefing/route.ts', 'utf8');
    const mark = bodyOf(route, 'if (brief.alsoToday.length > 0) {', ".in('id', brief.alsoToday.map(item => item.id));");
    expect(mark).toContain('const own = isManager(ctx.active.role) ? `user_id.eq.${ctx.user.id},user_id.is.null` : `user_id.eq.${ctx.user.id}`;');
    expect(mark).toContain(".eq('family_id', familyId).or(own)");
  });
});

