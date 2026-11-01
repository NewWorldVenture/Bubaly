import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderTranslated } from './helpers/render-translated';
import { textOf } from './helpers/render-server-page';
import { at } from './helpers/source-order';

// PERF-001. /dashboard/settings shifted its layout by 0.13 on every load: the
// profile nudge asked getProfileStateAction for its state once the page was on
// screen, and its card then arrived above the settings and pushed them down.
// The page now reads that state as it renders (lib/marketing/profile-state-server.ts)
// and hands it to the card, which is drawn in the first paint.
//
// The page cannot simply call the action: for a user who owns no contact yet
// it claims a lead by email or creates one, and a page GET (or a prefetch of
// one) must not write. So the page reads only what the user already owns and,
// for anyone else, leaves the card to the browser as before.

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  requireUserContext: vi.fn(),
  createServiceClient: vi.fn(),
  getProfileStateAction: vi.fn(),
}));
// The page asks Supabase Auth who is signed in; the action (compared with below) asks requireUserContext.
vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => ({ auth: { getUser: mocks.getUser } }),
  createServiceClient: mocks.createServiceClient,
}));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/referrals/server', () => ({ getReferralConfigResult: async () => ({ error: null, config: undefined }) }));
vi.mock('@/components/modules/settings-module', () => ({ SettingsModule: () => null }));
vi.mock('@/components/app/display-comfort', () => ({ DisplayComfort: () => null }));
vi.mock('@/app/(app)/dashboard/settings/profile-actions', () => ({
  getProfileStateAction: mocks.getProfileStateAction,
  saveProfileAnswerAction: vi.fn(),
  skipProfileFieldAction: vi.fn(),
}));

const { default: SettingsPage } = await import('@/app/(app)/dashboard/settings/page');
const { readOwnedProfileState } = await import('@/lib/marketing/profile-state-server');
const { ProfileNudge } = await import('@/components/marketing/profile-nudge');
// The real action, over the same mocked user and database, to compare with.
const actions = await vi.importActual<typeof import('@/app/(app)/dashboard/settings/profile-actions')>(
  '@/app/(app)/dashboard/settings/profile-actions');

type Admin = Parameters<typeof readOwnedProfileState>[0];

const WRITES = new Set(['insert', 'update', 'upsert', 'delete']);

/** The database as the service client, recording every write a query builder is asked for. */
function recording(db: InMemorySupabase) {
  const writes: string[] = [];
  const client = {
    from(table: string) {
      const builder = db.from(table);
      return new Proxy(builder, {
        get(target, prop) {
          if (typeof prop === 'string' && WRITES.has(prop)) writes.push(`${table}.${prop}`);
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
  return { admin: client as unknown as Admin, writes };
}

/** A read of `table` that does not answer, the three ways postgrest-js can deliver that. */
function failing(db: InMemorySupabase, table: string, how: 'error' | 'empty404' | 'throw'): Admin {
  const reply = how === 'error'
    ? { data: null, error: { message: 'upstream timeout', code: '', details: '', hint: '' } }
    : { data: null, error: null };
  const dead: object = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (ok?: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(reply).then(ok, ko);
      return () => dead;
    },
  });
  return {
    from(name: string) {
      if (name !== table) return db.from(name);
      if (how === 'throw') return { select: () => { throw new Error('fetch failed'); } };
      return { select: () => dead };
    },
  } as unknown as Admin;
}

const USER = { id: 'u-mom', email: 'mom@example.test' };
/** A whole crm_contact_profile row, as Postgres returns one: every column present, unset ones null. */
const profileRow = (contactId: string, set: Record<string, unknown>) => ({
  contact_id: contactId, role: null, top_priority: null, household_size: null, child_ages: null, interests: null, extra: {}, ...set,
});
const text = async () => textOf(renderTranslated(await SettingsPage()));
const CARD = 'Personalize Bubaly';

let db: InMemorySupabase;
let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  db = createInMemorySupabase();
  mocks.getUser.mockResolvedValue({ data: { user: USER }, error: null });
  mocks.requireUserContext.mockResolvedValue({ user: USER, memberships: [], active: null });
  mocks.createServiceClient.mockImplementation(() => db);
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.clearAllMocks(); errors.mockRestore(); });

describe('the settings page draws the profile card in its first paint', () => {
  it('for a user who owns a contact: the card is in the server render, on the question the person is up to', async () => {
    db.seed('crm_contacts', [{ id: 'c-mom', email: USER.email, owner_id: USER.id }]);
    db.seed('crm_contact_profile', [profileRow('c-mom', { role: 'parent', extra: { skipped: ['top_priority'] } })]);

    const page = await text();
    expect(page).toContain(CARD);
    // Role answered, priority dismissed: the next question is the household's size.
    expect(page).toContain('How big is your household?');
    expect(page).not.toContain('Who are you organizing for?');
  });

  it('for a user who owns a contact with no profile yet: the card opens on the first question', async () => {
    db.seed('crm_contacts', [{ id: 'c-mom', email: USER.email, owner_id: USER.id }]);
    const page = await text();
    expect(page).toContain(CARD);
    expect(page).toContain('Who are you organizing for?');
  });

  it('for a user who has answered everything: no card, from the server or later', async () => {
    db.seed('crm_contacts', [{ id: 'c-mom', email: USER.email, owner_id: USER.id }]);
    db.seed('crm_contact_profile', [profileRow('c-mom', {
      role: 'parent', top_priority: 'meals', household_size: 4, child_ages: 'school', interests: ['recipes'],
    })]);
    expect(await text()).not.toContain(CARD);
  });

  it('for a user who owns no contact: the page writes nothing, claims no lead, and leaves the card to the browser', async () => {
    // Their address is on an unclaimed lead. The action would claim it; a page render must not.
    db.seed('crm_contacts', [{ id: 'c-lead', email: USER.email, owner_id: null }]);
    const { admin, writes } = recording(db);
    mocks.createServiceClient.mockImplementation(() => admin);

    expect(await text()).not.toContain(CARD);
    expect(writes).toEqual([]);
    expect(db.table('crm_contacts')).toEqual([expect.objectContaining({ id: 'c-lead', owner_id: null })]);
    expect(db.table('crm_contact_profile')).toEqual([]);
  });

  it('signed out, or with Supabase Auth not answering: the page reads no profile and renders without the card', async () => {
    db.seed('crm_contacts', [{ id: 'c-mom', email: USER.email, owner_id: USER.id }]);
    const touched: string[] = [];
    mocks.createServiceClient.mockImplementation(() => ({ from: (table: string) => { touched.push(table); return db.from(table); } }));
    const failed = () => errors.mock.calls.filter((c: unknown[]) => c[0] === '[settings] signed-in user read failed').length;

    // Signed out is the ordinary state, not a failure: nothing is logged.
    mocks.getUser.mockResolvedValueOnce({ data: { user: null }, error: { name: 'AuthSessionMissingError', message: 'Auth session missing!' } });
    expect(await text()).not.toContain(CARD);
    expect(failed()).toBe(0);
    // A lookup that did not answer is logged.
    mocks.getUser.mockResolvedValueOnce({ data: { user: null }, error: { name: 'AuthRetryableFetchError', message: 'fetch failed' } });
    expect(await text()).not.toContain(CARD);
    expect(failed()).toBe(1);
    // Not a read, let alone a write, of a contact or a profile.
    expect(touched.filter((table) => table.startsWith('crm_'))).toEqual([]);
  });

  it('does not ask for the whole user context: two more reads a load, and a family provisioned during a GET', async () => {
    db.seed('crm_contacts', [{ id: 'c-mom', email: USER.email, owner_id: USER.id }]);
    expect(await text()).toContain(CARD);
    expect(mocks.requireUserContext).not.toHaveBeenCalled();
  });

  it.each([
    ['crm_contacts', 'error'], ['crm_contacts', 'empty404'], ['crm_contacts', 'throw'],
    ['crm_contact_profile', 'error'], ['crm_contact_profile', 'empty404'], ['crm_contact_profile', 'throw'],
  ] as const)('a %s read that does not answer (%s) renders the page, without the card, rather than failing it', async (table, how) => {
    db.seed('crm_contacts', [{ id: 'c-mom', email: USER.email, owner_id: USER.id }]);
    mocks.createServiceClient.mockImplementation(() => failing(db, table, how));
    expect(await text()).not.toContain(CARD);
  });
});

describe('readOwnedProfileState reads what getProfileStateAction reads, for a contact the user owns', () => {
  it.each([
    ['no profile row', null],
    ['some answers', { role: 'grandparent', household_size: 2 }],
    ['answers and dismissed questions', { role: 'caregiver', interests: ['travel', 'recipes'], extra: { skipped: ['child_ages', 'top_priority'] } }],
  ])('%s', async (_name, profile) => {
    db.seed('crm_contacts', [{ id: 'c-mom', email: USER.email, owner_id: USER.id }]);
    if (profile) db.seed('crm_contact_profile', [profileRow('c-mom', profile)]);

    const read = await readOwnedProfileState(db as unknown as Admin, USER.id);
    expect(read).not.toBeNull();
    expect(read).toEqual(await actions.getProfileStateAction());
  });

  it('answers null, not an empty profile, for a user who owns no contact', async () => {
    db.seed('crm_contacts', [{ id: 'c-other', email: 'other@example.test', owner_id: 'u-other' }]);
    db.seed('crm_contact_profile', [profileRow('c-other', { role: 'parent' })]);
    await expect(readOwnedProfileState(db as unknown as Admin, USER.id)).resolves.toBeNull();
  });
});

describe('the card works from the state it is handed', () => {
  const render = (initial?: Parameters<typeof ProfileNudge>[0]['initial']) =>
    textOf(renderTranslated(createElement(ProfileNudge, { initial })));

  it('is drawn at once from `initial`', () => {
    expect(render({ known: {}, skipped: [] })).toContain('Who are you organizing for?');
  });

  it('without `initial` it waits for the action, as before (nothing in the first paint)', () => {
    expect(render()).toBe('');
    expect(render(null)).toBe('');
  });

  it('does not ask the action again for state the page handed it', () => {
    // No DOM in this suite to run the effect in; its first statement is the guard.
    const source = readFileSync('components/marketing/profile-nudge.tsx', 'utf8');
    const effect = source.slice(at(source, 'useEffect(() => {'));
    expect(effect.startsWith("useEffect(() => {\n    if (initial) return; // the page read it\n")).toBe(true);
  });
});
