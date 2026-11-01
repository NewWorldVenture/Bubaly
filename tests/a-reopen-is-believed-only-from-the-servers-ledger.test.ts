// household-roles N6-R1-REOPEN-RESIDUAL-HAS-A-CODE-ONLY-LEDGER, round 7.
//
// Round 5 believed the audit_logs reopen entry because it has no actor, and a
// member's own entry must name the member when it is written (0380). Round 6
// recorded the residual: audit_logs.actor_id is `on delete set null` (0002),
// so a member who wrote the entry's exact shape and whose login was later
// deleted (removeChildLoginAction) left a row the server's to the letter. It
// held a never-closed family's posts (the drain, tests/social-scheduled-publish
// .test.ts) and read "<parent> updated family" on /family/activity.
//
// The reopen is now also recorded in social_audit_logs, which no member writes
// (0356 dropped every member INSERT, UPDATE and DELETE policy; its other writer,
// the social_write_audit trigger, records only 'INSERT', 'UPDATE', 'DELETE').
// The drain believes only that record, and /family/activity names the parent on
// the trail's reopen entry only beside one. Driven through the REAL
// reopenAccountAction and the REAL /family/activity and admin social audit pages
// over the in-memory database; the deleted login is the row's actor_id going
// null, as the foreign key does it.
import { readdirSync, readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemorySupabase, withFaults } from './helpers/in-memory-supabase';
import { renderServerPage, textOf } from './helpers/render-server-page';

const MESSAGES = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
const t = (key: string) => MESSAGES[key] ?? key;

const FAMILY = '22222222-2222-4222-8222-222222222277';
const PARENT = '11111111-1111-4111-8111-111111111177';
const CHILD = '44444444-4444-4444-8444-444444444477';
const CLOSED_AT = '2026-09-01T09:00:00.000Z';

const state = vi.hoisted(() => ({ db: undefined as unknown, raw: undefined as unknown as InMemorySupabase }));
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
const { default: AdminSocialAuditPage } = await import('@/app/(app)/admin/social/audit/page');

beforeEach(() => {
  vi.useRealTimers();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  // social_audit_logs.occurred_at defaults to now() (0034); the page orders and dates by it.
  state.raw = new InMemorySupabase({ userId: PARENT, defaults: { social_audit_logs: { occurred_at: new Date().toISOString() } } });
  state.db = state.raw;
  // A parent with no authenticator enrolled: reopening asks for no code.
  Object.assign(state.raw.auth, {
    getSession: async () => ({ data: { session: { access_token: 'synthetic-session' } }, error: null }),
    mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null }) },
  });
  state.raw.seed('families', [{ id: FAMILY, name: 'The Riveras', closed_at: CLOSED_AT, trial_ends_at: null }]);
  state.raw.seed('family_members', [
    { id: 'member-parent', family_id: FAMILY, user_id: PARENT, display_name: 'Dana', role: 'parent', is_active: true },
    { id: 'member-child', family_id: FAMILY, user_id: CHILD, display_name: 'Kit', role: 'child', is_active: true },
  ]);
});

/**
 * The child writes the reopen entry's exact shape as themselves (0380 lets them),
 * then a parent removes their login (removeChildLoginAction): the member row is
 * unlinked and the row's actor goes null with the auth user (0002).
 */
function aDeletedMembersReopenEntry(id: string, closedAt: string, createdAt: string) {
  state.raw.seed('audit_logs', [{ id, family_id: FAMILY, actor_id: CHILD, action: 'update', resource: 'family', resource_id: FAMILY,
    metadata: { change: 'reopened', closed_at: closedAt, reopened_by: PARENT }, created_at: createdAt }]);
  for (const m of state.raw.table('family_members')) if (m.user_id === CHILD) m.user_id = null;
  for (const r of state.raw.table('audit_logs')) if (r.actor_id === CHILD) r.actor_id = null;
}

/** Every list item of the activity page that reads `text`, as rendered. */
function linesOf(html: string, text: string): string[] {
  return html.split('<li').slice(1).filter((item) => item.includes(text));
}

describe('a reopen is believed only from the server’s ledger', () => {
  it('a deleted member’s entry of the exact reopen shape, in a family that never closed, does not read as the parent', async () => {
    state.raw.table('families')[0].closed_at = null;
    aDeletedMembersReopenEntry('planted', CLOSED_AT, '2026-10-20T09:00:00.000Z');

    const lines = linesOf(renderToStaticMarkup(await ActivityPage()), 'updated family');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Someone');
    expect(lines[0]).not.toContain('Dana');
  });

  it('control: the real reopen reads "Dana updated family", once, and a deleted member’s copy of it beside it reads "Someone"', async () => {
    expect(await reopenAccountAction()).toEqual({ ok: true });
    // The copy names the same parent and the same close (both readable to a member in the ledger), dated a day later.
    const reopenedAt = Date.parse(String(state.raw.table('audit_logs')[0].created_at));
    aDeletedMembersReopenEntry('copy', CLOSED_AT, new Date(reopenedAt + 86_400_000).toISOString());

    const html = renderToStaticMarkup(await ActivityPage());
    const lines = linesOf(html, 'updated family');

    expect(lines).toHaveLength(2);
    expect(lines.filter((line) => line.includes('Dana'))).toHaveLength(1);
    expect(lines.filter((line) => line.includes('Someone'))).toHaveLength(1);
    expect(html).not.toContain('undefined');
  });

  it('a ledger that cannot be read credits no one: the trail still renders, and the reopen reads "Someone"', async () => {
    expect(await reopenAccountAction()).toEqual({ ok: true });
    state.db = withFaults(state.raw, (table) => (table === 'social_audit_logs' ? { message: 'Synthetic ledger failure' } : null));

    const html = renderToStaticMarkup(await ActivityPage());

    expect(html).not.toContain(t('activity.couldnTLoadTheActivityLog'));
    const lines = linesOf(html, 'updated family');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Someone');
    expect(lines[0]).not.toContain('Dana');
  });

  it('the super administrators’ social audit page shows the ledger record as what it is', async () => {
    expect(await reopenAccountAction()).toEqual({ ok: true });

    const text = textOf(await renderServerPage(await AdminSocialAuditPage()));

    expect(text).toContain('account.reopened Account reopened');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('Invalid');
    expect(text).not.toContain(t('adminSocialAudit.noAuditEntriesYet'));
  });

  it('stands on the database: no member writes social_audit_logs, and its trigger never writes the reopen’s action', () => {
    // SQL this suite cannot run, pinned so that loosening it (a member policy
    // given back, another writer) is seen next to what depends on it.
    const dir = 'supabase/migrations';
    const naming = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .filter((f) => readFileSync(`${dir}/${f}`, 'utf8').includes('social_audit_logs'));
    expect(naming.at(-1)).toBe('0356_social_writes_need_the_social_permission.sql');
    expect(readFileSync(`${dir}/${naming.at(-1)}`, 'utf8')).toMatch(/array\['social_audit_logs',\s*null,\s*null,\s*null\]/);
    const held = readdirSync('supabase/reserved').filter((f) => f.endsWith('.sql'))
      .filter((f) => readFileSync(`supabase/reserved/${f}`, 'utf8').includes('social_audit_logs'));
    expect(held).toEqual([]);
    const writers = naming.flatMap((f) => readFileSync(`${dir}/${f}`, 'utf8').match(/insert into public\.social_audit_logs[^;]*;/g) ?? []);
    expect(writers).toHaveLength(1);
    expect(writers[0]).toMatch(/values \(v_family, auth\.uid\(\), tg_op,/);
  });
});
