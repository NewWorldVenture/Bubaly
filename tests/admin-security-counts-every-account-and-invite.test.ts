import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderServerPage, statCardValue } from './helpers/render-server-page';

// /admin/security took its account statistics from ONE page of
// `auth.admin.listUsers({ perPage: 1000 })` and its invite funnel from an
// unbounded `invites.select('status')`. GoTrue honours perPage 1000 for the
// first page and says nothing about the rest; PostgREST caps the invites read
// at 1,000 rows with no error. So past a thousand accounts or a thousand
// invites every figure — confirmed, unconfirmed, never signed in, banned, the
// funnel and its accept rate — was a prefix presented as a total.
const CAP = 1000;
const INVITES = 1300;
const USERS = 1250;
const pad = (i: number) => String(i).padStart(6, '0');

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => h.db,
  describeConfiguredServiceKey: () => null,
}));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
  getLocaleContext: async () => ({ locale: { code: 'en-US' } }),
}));
// The row control reaches for the app router, which a static render has not.
vi.mock('@/components/admin/user-security-actions', () => ({ UserSecurityActions: () => null }));

let db: InMemorySupabase;
let listUsersCalls: Array<{ page: number; perPage: number }>;

/**
 * A GoTrue that behaves like the real one where it matters: it clamps per_page
 * to 1,000, hands out that page, and says nothing about the pages after it.
 * The 250 UNCONFIRMED accounts, which never signed in, are all on page two.
 */
function authAdmin() {
  const all = Array.from({ length: USERS }, (_, i) => ({
    id: `auth-${pad(i)}`,
    email: `account-${pad(i)}@example.com`,
    email_confirmed_at: i < CAP ? '2026-01-01T00:00:00Z' : null,
    last_sign_in_at: i < CAP ? '2026-06-01T00:00:00Z' : null,
    banned_until: null,
    created_at: new Date(Date.UTC(2025, 0, 1) + i * 60_000).toISOString(),
  }));
  return {
    admin: {
      listUsers: async (params?: { page?: number; perPage?: number }) => {
        const perPage = Math.min(params?.perPage ?? 50, CAP);
        const page = params?.page ?? 1;
        listUsersCalls.push({ page, perPage });
        const start = (page - 1) * perPage;
        return {
          data: { users: all.slice(start, start + perPage), aud: 'authenticated', nextPage: null, lastPage: 2, total: USERS },
          error: null,
        };
      },
    },
  };
}

function seedPlatform() {
  // The 300 ACCEPTED invites are the last 300 rows, past a read of the first thousand.
  db.seed('invites', Array.from({ length: INVITES }, (_, i) => ({
    id: `inv-${pad(i)}`, family_id: `fam-${pad(i % 7)}`, email: `invitee-${i}@example.com`, role: 'adult',
    token: `tok-${i}`, status: i < CAP ? 'pending' : 'accepted', expires_at: '2027-01-01T00:00:00Z',
  })));
  db.seed('audit_logs', []);
  db.seed('families', []);
  db.seed('profiles', []);
}

async function render(): Promise<string> {
  const { default: AdminSecurityPage } = await import('@/app/(app)/admin/security/page');
  return renderServerPage(await AdminSecurityPage());
}

beforeEach(() => {
  db = createInMemorySupabase({ maxRows: CAP });
  listUsersCalls = [];
  (db as unknown as { auth: unknown }).auth = authAdmin();
  h.db = db;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-22T12:00:00Z'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('/admin/security counts every account and every invite', () => {
  it('the control: the fake caps an unbounded read at 1,000 and says nothing', async () => {
    seedPlatform();
    const { data, error } = await db.from('invites').select('status');
    expect(error).toBeNull();
    expect(data).toHaveLength(CAP);
  });

  it('the invite funnel and its accept rate see the invites past the cap', async () => {
    seedPlatform();
    const html = await render();
    expect(statCardValue(html, SOURCE_MESSAGES['adminSecurity.pendingInvites'])).toBe('1,000');
    // 300 accepted of 1,300.
    expect(statCardValue(html, SOURCE_MESSAGES['adminSecurity.inviteAcceptRate'])).toBe('23%');
    expect(html).toMatch(/accepted<\/span><span class="text-muted">300</);
  });

  it('account statistics read every page of auth users, not the first', async () => {
    seedPlatform();
    const html = await render();
    expect(statCardValue(html, SOURCE_MESSAGES['adminSecurity.unconfirmedEmails'])).toBe('250');
    expect(statCardValue(html, SOURCE_MESSAGES['adminSecurity.neverSignedIn'])).toBe('250');
    expect(html).toContain(`${CAP} / ${USERS}`);
    // It paged: page one, page two, and the empty page that proves the end.
    expect(listUsersCalls.map((c) => c.page)).toEqual([1, 2, 3]);
  });
});
