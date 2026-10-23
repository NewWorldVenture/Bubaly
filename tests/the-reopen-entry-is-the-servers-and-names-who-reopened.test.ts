// household-roles N4-R1-REOPEN-ROW-FORGEABLE, round 5.
//
// The social drain holds a post that came due while the account was closed
// when the family's audit trail has a reopen entry later than the due time
// (lib/family/account-reopened.ts). Any member may append to that trail as
// themselves (audit_insert, 0380), with any action, resource, metadata and
// created_at, so the entry a child wrote held posts in a family that never
// closed. The reopen is now the server's entry, with no actor (0380 refuses a
// member's insert that does not name the member, docs/audit/audit-actor-check.sql
// proves it in CI), and the parent who reopened is kept in its metadata.
//
// Here: the REAL reopenAccountAction writes it, and the REAL /family/activity
// page reads it back and names that parent, where a row with no actor read
// "Someone". A member's own row that names a parent in the same key is still
// the member's.
import { readdirSync, readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemorySupabase } from './helpers/in-memory-supabase';

const MESSAGES = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
const t = (key: string) => MESSAGES[key] ?? key;

const FAMILY = '22222222-2222-4222-8222-222222222222';
const PARENT = '11111111-1111-4111-8111-111111111111';
const CHILD = '44444444-4444-4444-8444-444444444444';
const CLOSED_AT = '2026-09-01T09:00:00.000Z';

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
  // A parent with no authenticator enrolled: reopening asks for no code.
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

/** The activity page's one list item for `text`, as rendered. */
function lineOf(html: string, text: string): string {
  const line = html.split('<li').find((item) => item.includes(text));
  expect(line, `no line reads "${text}"`).toBeDefined();
  return line!;
}

describe('the account reopen is the server\'s entry, and the trail names who reopened', () => {
  it('reopenAccountAction records it with no actor and the parent in its metadata', async () => {
    expect(await reopenAccountAction()).toEqual({ ok: true });
    expect(state.db.table('families')[0].closed_at).toBeNull();
    expect(state.db.table('audit_logs')).toEqual([expect.objectContaining({
      family_id: FAMILY, actor_id: null, action: 'update', resource: 'family', resource_id: FAMILY,
      metadata: { change: 'reopened', closed_at: CLOSED_AT, reopened_by: PARENT },
    })]);
  });

  it('/family/activity reads that entry as the parent\'s, not "Someone" and not "undefined"', async () => {
    expect(await reopenAccountAction()).toEqual({ ok: true });
    const html = renderToStaticMarkup(await ActivityPage());
    expect(html).not.toContain(t('activity.noActivityRecordedYet'));
    expect(html).not.toContain(t('activity.couldnTLoadTheActivityLog'));
    const line = lineOf(html, 'updated family');
    expect(line).toContain('Dana');
    expect(line).not.toContain('Someone');
    expect(html).not.toContain('undefined');
  });

  it('a member\'s own entry that names a parent as the reopener is still the member\'s', async () => {
    state.db.seed('audit_logs', [{ id: 'forged', family_id: FAMILY, actor_id: CHILD, action: 'update', resource: 'family',
      resource_id: FAMILY, metadata: { change: 'reopened', closed_at: CLOSED_AT, reopened_by: PARENT }, created_at: '2100-01-01T00:00:00.000Z' }]);
    const line = lineOf(renderToStaticMarkup(await ActivityPage()), 'updated family');
    expect(line).toContain('Kit');
    expect(line).not.toContain('Dana');
  });

  it('stands on the database: a member\'s audit entry must name the member, and no function writes one for them', () => {
    // The drain believes an entry with no actor because 0380 refuses a member's
    // insert that does not name the member. That is SQL this suite cannot run;
    // the probe runs it in CI. Pinned here so that loosening either premise
    // (a later audit_insert, or a definer function appending to audit_logs on
    // a member's call) is seen next to what depends on it.
    const dir = 'supabase/migrations';
    const migrations = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => readFileSync(`${dir}/${f}`, 'utf8'));
    const policies = migrations.flatMap((sql) => sql.match(/create policy audit_insert on public\.audit_logs[\s\S]*?;/g) ?? []);
    expect(policies.at(-1)).toMatch(/actor_id = auth\.uid\(\)/);
    expect(migrations.filter((sql) => /insert\s+into\s+(public\.)?audit_logs\b/i.test(sql))).toEqual([]);
    const probe = readFileSync('docs/audit/audit-actor-check.sql', 'utf8');
    expect(probe).toContain("insert into public.audit_logs (family_id, actor_id, action, resource) values (fam, null, 'delete', 'chores')");
    expect(probe).toContain('BREACH: a child wrote an unattributed audit entry');
  });

  it('an entry with no actor and no one recorded reads "Someone" (control)', async () => {
    state.db.seed('audit_logs', [{ id: 'system', family_id: FAMILY, actor_id: null, action: 'update', resource: 'family',
      resource_id: FAMILY, metadata: null, created_at: '2026-09-02T09:00:00.000Z' }]);
    const line = lineOf(renderToStaticMarkup(await ActivityPage()), 'updated family');
    expect(line).toContain('Someone');
    expect(line).not.toContain('undefined');
  });
});
