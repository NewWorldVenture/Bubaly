// Controlled model proof only. No Supabase/PostgreSQL execution or claim that
// this in-memory proxy implements all native RLS/trigger behavior.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ caller: null as unknown, server: null as unknown, user: 'child', role: 'child', active: true, service: true, serviceCalls: 0, fetchFeed: vi.fn(), outbound: vi.fn(), writes: [] as { target: string; op: string; active: boolean; role: string; allowed: boolean }[] }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ({ user: { id: h.user }, active: { familyId: 'family', role: h.role, member: { id: 'member-child' } } }) }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.caller, createServiceClient: () => { h.serviceCalls += 1; if (!h.service) throw new Error('synthetic-no-service-credentials'); return h.server; } }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/rate-limit', () => ({ rateLimit: () => ({ ok: true }) }));
vi.mock('@/lib/server/public-document-fetch', () => ({ fetchPublicFeed: h.fetchFeed }));
const { refreshFeedAction } = await import('@/app/(app)/dashboard/library/actions');
const XML = '<rss><channel><title>Controlled Show</title><item><guid>ep-1</guid><title>One</title><enclosure url="https://synthetic.invalid/one.mp3"/></item></channel></rss>';
let caller: InMemorySupabase;
let server: InMemorySupabase;
let entered: Promise<void>;
let release: () => void;

// Only the relevant released contract is modeled: 0003 active membership,
// 0284 item/feed policies, and 0464 guest guard wired by0481. Service writes
// intentionally bypass those caller checks, matching serverWriter's contract.
function client(db: InMemorySupabase, target: 'caller' | 'service') {
  return { from(table: string) {
    let op = 'select';
    const wrap = (query: object): object => new Proxy(query, { get(q, key) {
      if (key === 'then') return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
        if (op !== 'select' && ['library_feeds', 'library_items'].includes(table)) {
          const allowed = target === 'service' || (h.active && h.role !== 'guest');
          h.writes.push({ target, op, active: h.active, role: h.role, allowed });
          if (!allowed) {
            const filtered = !h.active && op === 'update';
            return Promise.resolve({ data: filtered ? [] : null, error: filtered ? null : { code: '42501', message: h.role === 'guest' ? 'A guest can see the household but not change it' : 'new row violates row-level security policy' }, count: filtered ? 0 : null }).then(resolve, reject);
          }
        }
        return Promise.resolve(q).then(resolve, reject);
      };
      const value = Reflect.get(q, key, q);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (['insert', 'update', 'upsert', 'delete'].includes(String(key))) op = String(key);
        const next = Reflect.apply(value, q, args);
        return next && typeof next === 'object' ? wrap(next) : next;
      };
    } });
    return wrap(db.from(table));
  } };
}
function seed(db: InMemorySupabase) {
  db.seed('family_members', [{ id: 'parent-member', family_id: 'family', user_id: 'parent', role: 'parent', is_active: true }, { id: 'member-child', family_id: 'family', user_id: 'child', role: 'child', is_active: true }]);
  db.seed('library_feeds', [{ id: 'feed', family_id: 'family', feed_url: 'https://synthetic.invalid/feed', created_by: 'parent', title: 'Before' }]);
}
beforeEach(() => {
  h.user = 'child'; h.role = 'child'; h.serviceCalls = 0; h.active = true; h.service = true; h.writes = [];
  caller = createInMemorySupabase(); server = createInMemorySupabase(); seed(caller); seed(server);
  h.caller = client(caller, 'caller'); h.server = client(server, 'service');
  let enter!: () => void;
  entered = new Promise<void>((resolve) => { enter = resolve; });
  const response = new Promise<void>((resolve) => { release = resolve; });
  h.fetchFeed.mockReset().mockImplementation(async (url: string) => { enter(); await response; return { url, text: XML }; });
  h.outbound.mockReset().mockImplementation(() => { throw new Error('Unexpected outbound fetch in controlled proof'); });
  vi.stubGlobal('fetch', h.outbound);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { expect(h.outbound).not.toHaveBeenCalled(); expect(h.serviceCalls).toBe(0); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('source-pinned library Refresh revocation model', () => {
  it('pins the released active-member and guest-write contracts separately from held0526', () => {
    const source = (p: string) => readFileSync(p, 'utf8');
    expect(source('supabase/migrations/0003_functions_triggers.sql')).toContain('where family_id = p_family_id and user_id = auth.uid() and is_active');
    expect(source('supabase/migrations/0284_library_books_podcasts.sql')).toContain('using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))');
    expect(source('supabase/migrations/0464_a_guest_views_the_household.sql')).toContain("public.family_role(new.family_id) = 'guest'");
    const wiring = source('supabase/migrations/0481_the_rls_sweep_narrows_the_household_tables_to_their_roles.sql');
    for (const table of ['library_feeds', 'library_items']) expect(wiring).toContain(`create trigger trg_${table}_not_a_guests before insert or update or delete`);
    expect(source('supabase/reserved/0526_what_the_library_streams_is_added_by_a_parent_or_adult.sql')).toContain('if me is null then\n    return new; -- service role / server-side jobs');
  });
  it.each(['child', 'parent'])('an active %s writes through their own client even when service credentials exist', async (role) => {
    h.user = role; h.role = role;
    const pending = refreshFeedAction('feed'); await entered; release();
    expect(await pending).toMatchObject({ ok: true });
    expect(caller.table('library_items')).toHaveLength(1);
    expect(server.table('library_items')).toHaveLength(0);
    expect(h.writes).toEqual([expect.objectContaining({ target: 'caller', op: 'update', allowed: true }), expect.objectContaining({ target: 'caller', op: 'upsert', allowed: true })]);
  });
  it('an active child succeeds without service credentials and does not try the service factory', async () => {
    h.service = false;
    const pending = refreshFeedAction('feed'); await entered; release();
    expect(await pending).toMatchObject({ ok: true });
    expect(caller.table('library_items')).toHaveLength(1); expect(server.table('library_items')).toHaveLength(0);
  });
  it.each(['deactivated', 'guest'] as const)('the actual caller write contract refuses publication after becoming %s during fetch', async (change) => {
    const pending = refreshFeedAction('feed'); await entered;
    expect(h.writes).toEqual([]); expect(caller.table('library_items')).toHaveLength(0);
    if (change === 'deactivated') h.active = false; else h.role = 'guest';
    release();
    expect(await pending).toMatchObject({ ok: false });
    expect(caller.table('library_items')).toHaveLength(0); expect(server.table('library_items')).toHaveLength(0);
    expect(h.writes).toContainEqual(expect.objectContaining({ target: 'caller', op: 'upsert', allowed: false }));
  });
  it('an initially guest caller is refused before the mocked feed and any write', async () => {
    h.role = 'guest';
    expect(await refreshFeedAction('feed')).toEqual({ ok: false, error: 'actionRefusal.notAllowed' });
    expect(h.fetchFeed).not.toHaveBeenCalled(); expect(h.writes).toEqual([]);
  });
});
