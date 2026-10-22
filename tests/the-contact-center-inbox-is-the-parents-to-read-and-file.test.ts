// The Contact Center (/dashboard/contact-center) lists the household inbox —
// every email, text and voicemail transcript the family's number and address
// receive — and offers Mark read / Archive on each message. Two defects met on
// that page, and both are driven here through the real page and action:
//
//   N1 — the owner's ROLE-SCOPE-001 decision withholds the household inbox
//   from a guest. /dashboard/inbox sent a guest away (requireFeature →
//   refuseGuest), but this page checked only the plan, and read the messages
//   with the SERVICE client, so a guest of a Family+ household read all of
//   them one route over — and the reserved 0509, which refuses a guest those
//   rows, could never have applied to a service-role read. The AI Front Desk
//   (/dashboard/front-desk) lists the voice rows of the same table, and was
//   not withheld either.
//
//   N2 — setMessageStatusAction checked only that the caller was signed in,
//   then wrote with the service role. A child or a guest could archive the
//   dentist's message, and it vanished from the parents' "Needs you" list
//   with nobody having answered it. Every other filing path refuses anyone
//   but a parent or adult.
//
// The database is an in-memory Supabase per client: the SERVICE client holds
// every row, the CALLER's client holds what RLS would let that caller read.
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = '11111111-1111-4111-8111-111111111111';
const LANDING = '/dashboard/grandparent-portal';
const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);

const state = vi.hoisted(() => ({
  role: 'parent' as string,
  level: 2,
  service: null as unknown,
  caller: null as unknown,
}));

const context = () => ({
  user: { id: 'user-1', email: null },
  active: {
    familyId: FAMILY, role: state.role,
    family: { id: FAMILY, name: 'Rivera', timezone: 'UTC' },
    member: { id: 'member-1' },
  },
});

vi.mock('next/navigation', () => ({
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); },
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES: messages } = await import('@/lib/i18n/messages');
  const { translate: tr } = await import('@/lib/i18n/translate');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => tr(messages, key, params) };
});
vi.mock('@/components/i18n/locale-provider', async () => {
  const { SOURCE_MESSAGES: messages } = await import('@/lib/i18n/messages');
  const { translate: tr } = await import('@/lib/i18n/translate');
  const { localeOrDefault } = await import('@/lib/i18n/locales');
  return {
    useTranslations: () => (key: string, params?: Record<string, string | number>) => tr(messages, key, params),
    useLocale: () => localeOrDefault('en-US'),
    useFamilyTimeZone: () => 'UTC',
  };
});
// The plan gate and the session, with the guest rule the real requireFeature
// applies first (lib/supabase/auth.ts; pinned by
// a-guest-does-not-read-the-households-most-sensitive-areas.test.ts).
vi.mock('@/lib/supabase/auth', async () => {
  const { refuseGuest } = await import('@/lib/auth/guest-scope');
  return {
    requireUserContext: async () => context(),
    requirePlanLevel: async () => context(),
    requireFeature: async (key: string) => { const ctx = context(); refuseGuest(ctx as never, key); return ctx; },
  };
});
vi.mock('@/lib/server/plan', () => ({ resolveFamilyPlanLevel: async () => state.level }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => state.service,
  createServer: async () => state.caller,
}));
vi.mock('@/lib/guardian/twilio', () => ({ isTwilioConfigured: () => false }));

const ContactCenterPage = (await import('@/app/(app)/dashboard/contact-center/page')).default;
const FrontDeskPage = (await import('@/app/(app)/dashboard/front-desk/page')).default;
const { setMessageStatusAction } = await import('@/app/(app)/dashboard/contact-center/actions');

let service: InMemorySupabase;
let caller: InMemorySupabase;

const message = (id: string, extra: Record<string, unknown> = {}) => ({
  id, family_id: FAMILY, channel: 'email', direction: 'inbound', from_addr: 'school@example.com', to_addr: 'rivera@bubaly.com',
  subject: 'Pickup', body: `Body of ${id}`, ai_summary: `Summary of ${id}`, ai_intent: 'other', ai_handled: false,
  status: 'new', occurred_at: '2026-10-13T09:00:00Z', ...extra,
});

const inboxReads = (db: InMemorySupabase) => db.log.filter((entry) => entry.table === 'family_inbox_messages').length;

beforeEach(() => {
  state.role = 'parent';
  state.level = 2;
  service = createInMemorySupabase();
  caller = createInMemorySupabase();
  state.service = service;
  state.caller = caller;
  service.seed('family_contact_channels', [{ family_id: FAMILY, email_local: 'rivera', ai_concierge_enabled: true }]);
});

describe('N1: a guest is not shown the household inbox on the Contact Center', () => {
  it('sends a guest of a Family+ household to their landing page, before any message is read', async () => {
    state.role = 'guest';
    service.seed('family_inbox_messages', [message('33333333-3333-4333-8333-000000000001')]);
    caller.seed('family_inbox_messages', [message('33333333-3333-4333-8333-000000000001')]);

    await expect(ContactCenterPage()).rejects.toThrow(`NEXT_REDIRECT ${LANDING}`);
    expect(inboxReads(service)).toBe(0);
    expect(inboxReads(caller)).toBe(0);
  });

  it('reads the messages as the CALLER, so the database\'s rule for who reads the inbox is the one obeyed', async () => {
    state.role = 'teen';
    // The service role sees every row; the caller's RLS-bound client answers
    // with what the policy lets this member read (here: one of the two).
    service.seed('family_inbox_messages', [message('33333333-3333-4333-8333-000000000001'), message('33333333-3333-4333-8333-000000000002')]);
    caller.seed('family_inbox_messages', [message('33333333-3333-4333-8333-000000000001')]);

    const page = await ContactCenterPage();

    expect((page.props.messages as { id: string }[]).map((m) => m.id)).toEqual(['33333333-3333-4333-8333-000000000001']);
    expect(inboxReads(service)).toBe(0);
    expect(renderToStaticMarkup(page)).not.toContain('Body of 33333333-3333-4333-8333-000000000002');
  });

  it('a parent still sees the inbox', async () => {
    caller.seed('family_inbox_messages', [message('33333333-3333-4333-8333-000000000001')]);
    const html = renderToStaticMarkup(await ContactCenterPage());
    expect(html).toContain('Summary of 33333333-3333-4333-8333-000000000001');
  });

  it('the AI Front Desk, which lists the inbox\'s calls, sends a guest away too', async () => {
    state.role = 'guest';
    caller.seed('family_inbox_messages', [message('33333333-3333-4333-8333-000000000003', { channel: 'voice', body: 'Voicemail transcript' })]);

    await expect(FrontDeskPage()).rejects.toThrow(`NEXT_REDIRECT ${LANDING}`);
    expect(inboxReads(caller)).toBe(0);
  });
});

describe('N2: only a parent or adult files a household message from the Contact Center', () => {
  const ID = '33333333-3333-4333-8333-000000000010';
  const statusOf = () => service.table('family_inbox_messages').find((row) => row.id === ID)?.status;

  it.each(['child', 'teen', 'caregiver', 'guest'])('a %s cannot archive or mark read a message through the action', async (role) => {
    state.role = role;
    service.seed('family_inbox_messages', [message(ID)]);

    for (const status of ['archived', 'read'] as const) {
      const result = await setMessageStatusAction(ID, status);
      expect(result).toEqual({ ok: false, error: t('actions.onlyAParentOrAdultCanFileAMessage') });
    }
    expect(statusOf()).toBe('new');
  });

  it('a parent below Family+ is refused, as the page\'s neighbouring actions refuse', async () => {
    state.level = 1;
    service.seed('family_inbox_messages', [message(ID)]);

    expect(await setMessageStatusAction(ID, 'archived')).toEqual({ ok: false, error: t('actions.theFamilyContactCenterIs') });
    expect(statusOf()).toBe('new');
  });

  it.each(['parent', 'adult'])('a %s on Family+ archives it', async (role) => {
    state.role = role;
    service.seed('family_inbox_messages', [message(ID)]);

    expect(await setMessageStatusAction(ID, 'archived')).toEqual({ ok: true });
    expect(statusOf()).toBe('archived');
  });

  it('the page offers Mark read and Archive only to a parent or adult', async () => {
    caller.seed('family_inbox_messages', [message(ID)]);
    for (const [role, offered] of [['child', false], ['teen', false], ['caregiver', false], ['adult', true], ['parent', true]] as const) {
      state.role = role;
      const html = renderToStaticMarkup(await ContactCenterPage());
      expect(html.includes(t('contactCenter.archive')), `${role} Archive`).toBe(offered);
      expect(html.includes(t('contactCenter.markRead')), `${role} Mark read`).toBe(offered);
    }
  });
});
