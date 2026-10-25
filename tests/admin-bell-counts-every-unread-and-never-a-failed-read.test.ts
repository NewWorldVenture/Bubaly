import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, withFaults, type FaultCall, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { byName, click, has, nodes, render, text } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// The admin shell's notification bell, as the admin layout feeds it.
//   - Class B: its unread badge, and its Mark all read, counted the unread
//     among the 20 newest notifications it lists, so past them it said a
//     smaller number, or nothing at all while older ones were unread. It is a
//     head:true count of every unread notification now.
//   - Class A: a failed pending-invite count reached it as 0 (no invite row,
//     nothing on the badge), and a failed feed as [] ("You're all caught up"),
//     while only the shell's footer said a read had failed. Each now reaches
//     it as null, and the bell says so: the badge is a "!" and not a number,
//     the dropdown names the read, and Mark all read is not offered.
// The REAL layout over the in-memory database (PostgREST's 1,000-row cap),
// and the REAL bell with its hooks as slots.
const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('next/link', async () => {
  const { createElement: el } = await import('react');
  return { default: ({ children, href, ...props }: { children?: ReactNode; href: string }) => el('a', { href, ...props }, children) };
});
vi.mock('next/navigation', () => ({
  redirect: () => { throw new Error('unexpected redirect'); },
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => h.db,
  describeConfiguredServiceKey: () => null,
  serviceKeyRemedy: () => null,
}));
vi.mock('@/lib/supabase/auth', () => ({
  getUser: async () => ({ id: 'admin-1', email: 'admin@example.com' }),
  isSuperAdmin: async () => true,
}));
vi.mock('@/lib/auth/super-admin-assurance', () => ({
  superAdminAssurance: async () => ({ ok: true }),
  SUPER_ADMIN_STEP_UP_PATH: '/auth/step-up?next=%2Fadmin',
}));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
}));
vi.mock('@/app/(app)/admin/notifications-actions', () => ({ markAdminNotesReadAction: async () => ({ ok: true }) }));

const CAP = 1000;
const pad = (i: number) => String(i).padStart(6, '0');
let db: InMemorySupabase;

type BellProps = { notifications: Row[] | null; pendingInviteCount: number | null; unreadCount: number | null };

/** What the real layout hands the shell's bell. */
async function bellProps(): Promise<BellProps> {
  const { default: Layout } = await import('@/app/(app)/admin/layout');
  const element = await Layout({ children: null }) as ReactElement<BellProps & { dataWarnings: string[] }>;
  return { notifications: element.props.notifications, pendingInviteCount: element.props.pendingInviteCount, unreadCount: element.props.unreadCount };
}

/** The real bell, opened. */
async function openBell(props: BellProps): Promise<{ closed: ReactNode; open: ReactNode }> {
  const { AdminNotificationBell } = await import('@/components/admin/admin-notification-bell');
  resetHookSlots(h.hooks);
  const element = createElement(AdminNotificationBell, props as never);
  const closed = render(h.hooks, element);
  await click(byName(closed, /^Notifications/, 'button'));
  return { closed, open: render(h.hooks, element) };
}

/** The badge on the bell button, or null. */
const badge = (tree: ReactNode) => {
  const button = byName(tree, /^Notifications/, 'button');
  const span = nodes(button).find((n) => n.type === 'span');
  return span ? text(span) : null;
};
const markAllRead = (tree: ReactNode) => has(tree, SOURCE_MESSAGES['adminNotificationBell.markAllRead']);

const note = (k: number, isRead: boolean): Row => ({
  id: `note-${pad(k)}`, kind: 'support_ticket', title: `Note ${k}`, body: null, url: null, is_read: isRead,
  created_at: new Date(Date.UTC(2026, 0, 1) + k * 60_000).toISOString(),
});
function seed(unread: number, read: number, pendingInvites = 0) {
  db.seed('profiles', [{ id: 'admin-1', full_name: 'Admin', email: 'admin@example.com' }]);
  // The unread are the OLDEST: the 20 newest the bell lists hold none of them.
  db.seed('admin_notifications', [
    ...Array.from({ length: unread }, (_, k) => note(k, false)),
    ...Array.from({ length: read }, (_, k) => note(unread + k, true)),
  ]);
  db.seed('invites', Array.from({ length: pendingInvites }, (_, k) => ({ id: `inv-${k}`, status: 'pending' })));
}
const head = (calls: FaultCall[]) => calls.some((c) => c.method === 'select' && (c.args[1] as { head?: boolean } | undefined)?.head === true);
function fault(table: string, failing: (calls: FaultCall[]) => boolean) {
  h.db = withFaults(db, (name, calls) => (name === table && failing(calls) ? { message: `${table} unavailable` } : null));
}

beforeEach(() => {
  // The open dropdown listens for a click outside it; there is no DOM here.
  vi.stubGlobal('document', { addEventListener: () => {}, removeEventListener: () => {} });
  resetHookSlots(h.hooks);
  db = createInMemorySupabase({ maxRows: CAP });
  h.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the admin bell counts every unread notification, not the 20 it lists', () => {
  it('unread notifications older than the 20 listed still badge the bell and offer Mark all read', async () => {
    seed(3, 25);
    const props = await bellProps();
    expect(props.notifications).toHaveLength(20);
    expect(props.unreadCount).toBe(3);
    const { closed, open } = await openBell(props);
    expect(badge(closed)).toBe('3');
    expect(markAllRead(open)).toBe(true);
  });

  it('past nine unread the badge says 9+, counted over every one', async () => {
    seed(40, 0);
    const props = await bellProps();
    expect(props.unreadCount).toBe(40);
    expect(badge((await openBell(props)).closed)).toBe('9+');
  });

  it('the control: with nothing unread and no pending invite there is no badge, no Mark all read, and it is all caught up', async () => {
    seed(0, 25);
    const props = await bellProps();
    expect(props.unreadCount).toBe(0);
    const { closed, open } = await openBell(props);
    expect(badge(closed)).toBeNull();
    expect(markAllRead(open)).toBe(false);
    expect(has(open, 'Note 24')).toBe(true);
  });
});

describe('the admin bell never shows a failed read as a value', () => {
  it('a pending-invite count that FAILS: the badge is "!", and the dropdown says the count is unavailable', async () => {
    seed(0, 2, 4);
    fault('invites', head);
    const props = await bellProps();
    expect(props.pendingInviteCount).toBeNull();
    const { closed, open } = await openBell(props);
    expect(badge(closed)).toBe('!');
    expect(has(open, SOURCE_MESSAGES['adminCredential.invitesUnavailable'])).toBe(true);
    expect(has(open, SOURCE_MESSAGES['adminNotificationBell.pendingInvite'])).toBe(false);
  });

  it('an unread count that FAILS: the badge is "!", and Mark all read is not offered', async () => {
    seed(3, 2);
    fault('admin_notifications', head);
    const props = await bellProps();
    expect(props.unreadCount).toBeNull();
    const { closed, open } = await openBell(props);
    expect(badge(closed)).toBe('!');
    expect(markAllRead(open)).toBe(false);
    expect(has(open, 'Note 4')).toBe(true);
  });

  // The shell's footer and the bell said "The admin notification feed is
  // unavailable." when only the count had failed, while the feed loaded and
  // was listed (review R9-UNREAD-COUNT-FAILURE-COPY). The count has its own line.
  it('an unread count that FAILS names the count, in the shell and in the bell, not the feed', async () => {
    seed(3, 2);
    let faulted = 0;
    h.db = withFaults(db, (name, calls) => {
      if (name !== 'admin_notifications' || !head(calls)) return null;
      faulted += 1;
      return { message: 'admin_notifications unavailable' };
    });
    const { default: Layout } = await import('@/app/(app)/admin/layout');
    const element = await Layout({ children: null }) as ReactElement<BellProps & { dataWarnings: string[] }>;
    expect(faulted).toBe(1);
    expect(element.props.dataWarnings).toEqual([SOURCE_MESSAGES['adminCredential.unreadCountUnavailable']]);
    const { open } = await openBell(element.props);
    expect(has(open, SOURCE_MESSAGES['adminCredential.unreadCountUnavailable'])).toBe(true);
    expect(has(open, SOURCE_MESSAGES['adminCredential.notificationsUnavailable'])).toBe(false);
    expect(has(open, 'Note 4')).toBe(true);
  });

  it('the control: a feed and a count that both FAIL are one line, the feed\'s', async () => {
    seed(3, 2);
    fault('admin_notifications', () => true);
    const { default: Layout } = await import('@/app/(app)/admin/layout');
    const element = await Layout({ children: null }) as ReactElement<BellProps & { dataWarnings: string[] }>;
    expect(element.props.dataWarnings).toEqual([SOURCE_MESSAGES['adminCredential.notificationsUnavailable']]);
    const { open } = await openBell(element.props);
    expect(has(open, SOURCE_MESSAGES['adminCredential.unreadCountUnavailable'])).toBe(false);
  });

  it('a feed that FAILS is "unavailable", not "You\'re all caught up"', async () => {
    seed(0, 0);
    fault('admin_notifications', (calls) => !head(calls));
    const props = await bellProps();
    expect(props.notifications).toBeNull();
    const { open } = await openBell(props);
    expect(has(open, SOURCE_MESSAGES['adminCredential.notificationsUnavailable'])).toBe(true);
    expect(has(open, SOURCE_MESSAGES['adminNotificationBell.youreAllCaughtUp'])).toBe(false);
  });

  it('the control: with every read answering, pending invites show their count and an empty feed is all caught up', async () => {
    seed(0, 0, 2);
    const props = await bellProps();
    expect(props).toMatchObject({ pendingInviteCount: 2, unreadCount: 0 });
    const { closed, open } = await openBell(props);
    expect(has(open, SOURCE_MESSAGES['adminCredential.unreadCountUnavailable'])).toBe(false);
    expect(badge(closed)).toBe('1');
    expect(has(open, `2 ${SOURCE_MESSAGES['adminNotificationBell.pendingInvite']}s`)).toBe(true);
    expect(has(open, SOURCE_MESSAGES['adminCredential.invitesUnavailable'])).toBe(false);
    db.replace('invites', []);
    expect(has((await openBell(await bellProps())).open, SOURCE_MESSAGES['adminNotificationBell.youreAllCaughtUp'])).toBe(true);
  });
});
