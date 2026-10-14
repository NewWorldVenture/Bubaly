// A4 — notification digests were emailed to kid-login addresses.
//
// A kid login's account address is synthetic: child.<username>@kids.bubaly.app
// (lib/onboarding/child-login.ts says "Nothing is ever delivered there"). The
// digest checked only the member's own email toggle and the family's
// child_channels, which a teen PIN login never matches and which defaults to
// allowed, so a child's chores, assigned events with their locations and their
// display name were mailed to a domain Bubaly does not hold — bouncing today,
// delivered to whoever registers it tomorrow. The invite route could mail a
// join token there too.
//
// Now: the digest settles a synthetic recipient without sending (as "no email
// on file"), both senders refuse such an address before the provider is asked,
// and the invite route refuses to mail one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const providers = vi.hoisted(() => ({ email: vi.fn(), users: vi.fn(), resend: vi.fn(), fetch: vi.fn() }));
vi.mock('@/lib/email', () => ({ emailEnabled: () => true, sendReactEmail: providers.email, FROM_EMAIL: 'Bubaly <hello@bubaly.test>', APP_URL: 'https://bubaly.test' }));
vi.mock('@/lib/server/list-all-auth-users', () => ({ listAllAuthUsers: providers.users }));
vi.mock('resend', () => ({ Resend: class { emails = { send: providers.resend }; } }));
vi.mock('@/lib/server/fetch-with-deadline', () => ({ fetchWithDeadline: providers.fetch }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'u-parent' }, memberships: [],
    active: { familyId: 'fam-1', role: 'parent', member: { id: 'm-parent', display_name: 'Ada' }, family: { id: 'fam-1', name: 'The Riveras' } },
  }),
}));
vi.mock('@/lib/supabase/server', async () => ({ createServer: async () => db, createServiceClient: () => db }));
vi.mock('@/lib/server/request-rate-limit', () => ({ enforceRequestRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/emails/invite', () => ({ InviteEmail: () => null }));

const { deliverNotificationEmails } = await import('@/lib/server/notification-emails');
const { sendEmail } = await import('@/lib/server/email');
const { POST: sendInvite } = await import('@/app/api/email/invite/route');
const realEmail = await vi.importActual<typeof import('@/lib/email')>('@/lib/email');

const FAMILY = 'fam-1';
const NOW = new Date('2026-10-06T15:00:00Z');
let db: InMemorySupabase;

function household() {
  db = createInMemorySupabase();
  db.seed('families', [{ id: FAMILY, timezone: 'UTC', closed_at: null }]);
  db.seed('family_members', [
    { id: 'm-parent', family_id: FAMILY, user_id: 'u-parent', role: 'parent', is_active: true },
    { id: 'm-teen', family_id: FAMILY, user_id: 'u-teen', role: 'teen', is_active: true },
    { id: 'm-kid', family_id: FAMILY, user_id: 'u-kid', role: 'child', is_active: true },
  ]);
  db.seed('user_preferences', []);
  db.seed('notifications', ['u-parent', 'u-teen', 'u-kid'].map((user) => ({
    id: `n-${user}`, family_id: FAMILY, user_id: user, type: 'chore_due', title: 'Chore due: Feed the cat', body: 'Due today at 5:00 PM',
    related_type: 'chore_assignments', related_id: `ca-${user}`, send_at: '2026-10-06T14:00:00Z', sent_at: null, created_at: '2026-10-06T14:00:00Z',
  })));
  providers.users.mockResolvedValue({
    users: [
      { id: 'u-parent', email: 'parent@example.test', user_metadata: {} },
      // A teen with a PIN login: role teen, so child_channels never covers it.
      { id: 'u-teen', email: 'child.sam@kids.bubaly.app', user_metadata: { display_name: 'Sam' } },
      { id: 'u-kid', email: 'Child.Ella@Kids.Bubaly.App', user_metadata: { display_name: 'Ella' } },
    ],
    error: null,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  providers.email.mockReset().mockResolvedValue({ ok: true });
  providers.resend.mockReset().mockResolvedValue({ data: { id: 'x' }, error: null });
  providers.fetch.mockReset().mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubEnv('RESEND_API_KEY', 're_fixture');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  household();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('the notification digest never mails a kid login', () => {
  it('emails the parent, and settles the kid logins\' rows without sending them anywhere', async () => {
    const result = await deliverNotificationEmails(db as unknown as SupabaseClient<Database>);
    expect(result).toEqual({ sent: 1, failed: 0, skipped: 2 });
    expect(providers.email.mock.calls.map(([args]) => args.to)).toEqual(['parent@example.test']);
    // Settled, so they are not retried on every run either.
    expect(db.table('notifications').every((n) => typeof n.sent_at === 'string')).toBe(true);
  });
});

describe('neither sender will address a kid login', () => {
  it('sendReactEmail refuses before the provider is asked', async () => {
    const sent = await realEmail.sendReactEmail({ to: 'child.ella@kids.bubaly.app', subject: 'Your chores', react: null as never });
    expect(sent).toEqual({ ok: false });
    expect(providers.resend).not.toHaveBeenCalled();
    // A list that includes one is refused whole.
    expect(await realEmail.sendReactEmail({ to: ['parent@example.test', 'CHILD.SAM@KIDS.BUBALY.APP'], subject: 'x', react: null as never })).toEqual({ ok: false });
    expect(providers.resend).not.toHaveBeenCalled();
  });

  it('sendReactEmail still sends to an ordinary address (control)', async () => {
    expect(await realEmail.sendReactEmail({ to: 'parent@example.test', subject: 'Hello', react: null as never })).toEqual({ ok: true });
    expect(providers.resend).toHaveBeenCalledTimes(1);
  });

  it('sendEmail refuses too, and still sends to an ordinary address (control)', async () => {
    expect(await sendEmail({ to: 'child.ella@kids.bubaly.app', subject: 'x', html: '<p>x</p>' })).toEqual({ ok: false, reason: 'rejected' });
    expect(providers.fetch).not.toHaveBeenCalled();
    expect(await sendEmail({ to: 'parent@example.test', subject: 'x', html: '<p>x</p>' })).toEqual({ ok: true });
    expect(providers.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('an invite is never mailed to a kid login', () => {
  const post = (inviteId: string) => sendInvite(new Request('https://bubaly.test/api/email/invite', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inviteId }),
  }) as never);

  beforeEach(() => {
    const soon = new Date(NOW.getTime() + 7 * 86_400_000).toISOString();
    db.seed('invites', [
      { id: 'i-kid', family_id: FAMILY, email: 'child.ella@kids.bubaly.app', role: 'guest', token: 'tok-kid', status: 'pending', expires_at: soon },
      { id: 'i-gran', family_id: FAMILY, email: 'gran@example.test', role: 'guest', token: 'tok-gran', status: 'pending', expires_at: soon },
    ]);
  });

  it('the invite route refuses a kid-login address, and mails nothing', async () => {
    const res = await post('i-kid');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'inviteForm.aKidLoginCannotBeInvited' });
    expect(providers.email).not.toHaveBeenCalled();
  });

  it('still mails an ordinary invite (control)', async () => {
    const res = await post('i-gran');
    expect(res.status).toBe(200);
    expect(providers.email.mock.calls.map(([args]) => args.to)).toEqual(['gran@example.test']);
  });
});
