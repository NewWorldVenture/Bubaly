// household-roles N5-R1-NULL-ACTOR-TRAIL-ATTRIBUTION, round 6.
//
// Round 5 had /family/activity name metadata.reopened_by on ANY row with no
// actor, on the premise that only the server writes one. That holds only when
// the row is written: audit_logs.actor_id is `references auth.users(id) on
// delete set null` (0002), and removeChildLoginAction deletes a PIN child's
// login, so a child's own row ends with no actor once a parent removes it. A
// child could write { action: 'delete', resource: 'wallet_transactions',
// metadata: { reopened_by: <parent>, title: 'Sent $200 to an outside account' } }
// as themselves (0380 allows it), and once their login went the trail read
// "Dana Sent $200 to an outside account".
//
// The key is now read only on the server's reopen entry, by its exact shape
// (no actor, update, family, change 'reopened'), and that line says only
// "updated family". Every other row with no actor reads "Someone". Rendered
// through the REAL /family/activity page over the in-memory database; the
// deleted login is the row's actor_id going null, as the foreign key does it.
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemorySupabase } from './helpers/in-memory-supabase';

const MESSAGES = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
const t = (key: string) => MESSAGES[key] ?? key;

const FAMILY = '22222222-2222-4222-8222-222222222266';
const PARENT = '11111111-1111-4111-8111-111111111166';
const CHILD = '44444444-4444-4444-8444-444444444466';
const CLOSED_AT = '2026-09-01T09:00:00.000Z';
const FRAMED = 'Sent $200 to an outside account';

const state = vi.hoisted(() => ({ db: undefined as unknown as InMemorySupabase }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => state.db, createServiceClient: () => state.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: PARENT },
    active: {
      familyId: FAMILY, role: 'parent',
      member: { id: 'member-parent', family_id: FAMILY, user_id: PARENT },
      family: { id: FAMILY, name: 'The Riveras', timezone: 'UTC' },
    },
  }),
}));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => t,
  getLocaleContext: async () => ({ locale: { code: 'en-US' }, messages: {} }),
}));
vi.mock('next/cache', () => ({ revalidatePath() {} }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get() {}, set() {} }) }));

const { reopenAccountAction } = await import('@/app/(app)/account/actions');
const { default: ActivityPage } = await import('@/app/(app)/family/activity/page');

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  state.db = new InMemorySupabase({ userId: PARENT });
  Object.assign(state.db.auth, {
    getSession: async () => ({ data: { session: { access_token: 'synthetic-session' } }, error: null }),
    mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null }) },
  });
  state.db.seed('families', [{ id: FAMILY, name: 'The Riveras', closed_at: CLOSED_AT, trial_ends_at: null }]);
  state.db.seed('family_members', [
    { id: 'member-parent', family_id: FAMILY, user_id: PARENT, display_name: 'Dana', role: 'parent', is_active: true },
    { id: 'member-child', family_id: FAMILY, user_id: CHILD, display_name: 'Kit', role: 'child', is_active: true },
  ]);
});

/**
 * The child writes a row as themselves (0380); later a parent removes their
 * login, which unlinks the member row and deletes the auth user
 * (removeChildLoginAction), and the row's actor goes null with it (0002's
 * `on delete set null`).
 */
function childRowWhoseLoginWasDeleted(row: { action: string; resource: string; metadata: Record<string, unknown> }) {
  state.db.seed('audit_logs', [{ id: 'planted', family_id: FAMILY, actor_id: CHILD, resource_id: null, created_at: '2026-10-20T09:00:00.000Z', ...row }]);
  for (const m of state.db.table('family_members')) if (m.user_id === CHILD) m.user_id = null;
  for (const r of state.db.table('audit_logs')) if (r.actor_id === CHILD) r.actor_id = null;
}

/** The activity page's one list item for `text`, as rendered. */
function lineOf(html: string, text: string): string {
  const line = html.split('<li').find((item) => item.includes(text));
  expect(line, `no line reads "${text}"`).toBeDefined();
  return line!;
}

describe('a row that lost its actor is not a parent\'s', () => {
  it.each([
    ['a wallet removal with a title', { action: 'delete', resource: 'wallet_transactions', metadata: { reopened_by: PARENT, title: FRAMED } }, FRAMED],
    ['a family update that is not the reopen', { action: 'update', resource: 'family', metadata: { change: 'renamed', reopened_by: PARENT } }, 'updated family'],
    ['the reopen\'s change on another resource', { action: 'update', resource: 'family_members', metadata: { change: 'reopened', reopened_by: PARENT } }, 'updated family members'],
    ['the reopen\'s change with another verb', { action: 'delete', resource: 'family', metadata: { change: 'reopened', reopened_by: PARENT } }, 'removed family'],
  ])('/family/activity reads %s naming a parent as "Someone", not the parent', async (_label, row, what) => {
    childRowWhoseLoginWasDeleted(row);

    const line = lineOf(renderToStaticMarkup(await ActivityPage()), what);

    expect(line).toContain('Someone');
    expect(line).not.toContain('Dana');
  });

  it('the reopen\'s exact shape still names the parent, but only in the server\'s words, never a title planted in it', async () => {
    childRowWhoseLoginWasDeleted({ action: 'update', resource: 'family', metadata: { change: 'reopened', reopened_by: PARENT, title: FRAMED } });

    const html = renderToStaticMarkup(await ActivityPage());

    expect(html).not.toContain(FRAMED);
    expect(lineOf(html, 'updated family')).toContain('Dana');
  });

  it('control: the server\'s own reopen entry, written by the real reopenAccountAction, reads as the parent\'s', async () => {
    expect(await reopenAccountAction()).toEqual({ ok: true });

    const line = lineOf(renderToStaticMarkup(await ActivityPage()), 'updated family');

    expect(line).toContain('Dana');
    expect(line).not.toContain('Someone');
  });

  it('control: a member\'s row that still has its actor reads as that member\'s, title and all', async () => {
    state.db.seed('audit_logs', [{ id: 'own', family_id: FAMILY, actor_id: CHILD, action: 'delete', resource: 'wallet_transactions',
      resource_id: null, metadata: { reopened_by: PARENT, title: FRAMED }, created_at: '2026-10-20T09:00:00.000Z' }]);

    const line = lineOf(renderToStaticMarkup(await ActivityPage()), FRAMED);

    expect(line).toContain('Kit');
    expect(line).not.toContain('Dana');
  });
});
