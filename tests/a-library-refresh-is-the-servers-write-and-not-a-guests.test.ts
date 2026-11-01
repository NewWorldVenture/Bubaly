// KIDS-O02 — the library's "an adult adds what every child streams" rule moves
// into the database (held 0526): only a parent or another adult adds a feed or
// an audio address, there as in the actions. Refresh stays anyone's, and it used
// to ingest on the presser's own session, so a child's Refresh wrote the
// episodes, audio addresses included, as the child. Under 0526 that write is
// refused, and every child's Refresh would fail.
//
// Human ingest retains the caller's write client after the family-pinned read
// and curator check, including after the external fetch. The deferred-fetch
// regression separately checks revocation against the released permission model.
// Held0526 must fail honestly for a child until an atomic refresh is approved;
// the background cron's service client does not authorize a human request.
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const MESSAGES = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;

const h = vi.hoisted(() => ({ caller: null as unknown, server: null as unknown, user: 'user-parent', role: 'parent', fetchPublicFeed: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: h.user }, active: { familyId: 'fam-lib', role: h.role, member: { id: `m-${h.role}` } } }),
}));
// The presser's own session, and the server's: two databases, so a test can say
// which one a write went through.
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.caller, createServiceClient: () => h.server }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/i18n/server', async () => {
  const { translate: tr } = await import('@/lib/i18n/translate');
  const { readFileSync: read } = await import('node:fs');
  const messages = JSON.parse(read('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => tr(messages, key, params) };
});
vi.mock('@/lib/server/rate-limit', () => ({ rateLimit: () => ({ ok: true }) }));
vi.mock('@/lib/server/public-document-fetch', async (original) => ({
  ...(await original<typeof import('@/lib/server/public-document-fetch')>()),
  fetchPublicFeed: h.fetchPublicFeed,
}));

const { refreshFeedAction } = await import('@/app/(app)/dashboard/library/actions');

const FAMILY = 'fam-lib';
const FEED_XML = '<rss><channel><title>Show</title><item><guid>ep-1</guid><title>One</title><enclosure url="https://cdn.test/1.mp3"/></item></channel></rss>';
let caller: InMemorySupabase;
let server: InMemorySupabase;

function seed(db: InMemorySupabase) {
  db.seed('families', [{ id: FAMILY, closed_at: null }, { id: 'fam-other', closed_at: null }]);
  db.seed('family_members', [
    { id: 'm-parent', family_id: FAMILY, user_id: 'user-parent', role: 'parent', is_active: true, display_name: 'Ada' },
    { id: 'm-child', family_id: FAMILY, user_id: 'user-child', role: 'child', is_active: true, display_name: 'Kit' },
    { id: 'm-guest', family_id: FAMILY, user_id: 'user-guest', role: 'guest', is_active: true, display_name: 'Gran' },
    { id: 'm-other', family_id: 'fam-other', user_id: 'user-other', role: 'parent', is_active: true, display_name: 'Bo' },
  ]);
  db.seed('library_feeds', [
    { id: 'feed-parent', family_id: FAMILY, kind: 'podcast', title: 'https://parent.test/feed', feed_url: 'https://parent.test/feed', created_by: 'user-parent', last_fetched_at: null, last_error: null },
    { id: 'feed-other', family_id: 'fam-other', kind: 'podcast', title: 'Elsewhere', feed_url: 'https://other.test/feed', created_by: 'user-other', last_fetched_at: null, last_error: null },
  ]);
}

const as = (user: string, role: string) => { h.user = user; h.role = role; };
const episodes = (db: InMemorySupabase) => db.table('library_items').map((row) => [row.family_id, row.feed_id, row.guid, row.media_url]);

beforeEach(() => {
  caller = createInMemorySupabase({ maxRows: 1000 });
  server = createInMemorySupabase({ maxRows: 1000 });
  seed(caller);
  seed(server);
  h.caller = caller;
  h.server = server;
  as('user-parent', 'parent');
  h.fetchPublicFeed.mockReset().mockImplementation(async (url: string) => ({ url, text: FEED_XML }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('a human Refresh keeps the presser\'s write client', () => {
  it.each([['user-child', 'child'], ['user-parent', 'parent']])('%s: episodes and description land through the presser\'s client even when a service client exists', async (user, role) => {
    as(user, role);
    expect((await refreshFeedAction('feed-parent')).ok).toBe(true);

    expect(episodes(caller)).toEqual([[FAMILY, 'feed-parent', 'ep-1', 'https://cdn.test/1.mp3']]);
    expect(caller.table('library_feeds').find((f) => f.id === 'feed-parent')).toMatchObject({ title: 'Show', last_error: null, last_fetched_at: expect.any(String) });
    expect(episodes(server)).toEqual([]);
    expect(server.table('library_feeds').find((f) => f.id === 'feed-parent')).toMatchObject({ title: 'https://parent.test/feed', last_fetched_at: null });
  });

  it('publication follows the presser\'s own family-pinned read: another family\'s feed is not found', async () => {
    as('user-child', 'child');
    expect(await refreshFeedAction('feed-other')).toEqual({ ok: false, error: 'That subscription could not be found.' });
    expect(h.fetchPublicFeed).not.toHaveBeenCalled();
    expect(episodes(server)).toEqual([]);
  });

  it('a guest is refused before anything is read or fetched', async () => {
    as('user-guest', 'guest');
    expect(await refreshFeedAction('feed-parent')).toEqual({ ok: false, error: translate(MESSAGES, 'actionRefusal.notAllowed') });
    expect(h.fetchPublicFeed).not.toHaveBeenCalled();
    expect(episodes(server)).toEqual([]);
    expect(server.table('library_feeds').find((f) => f.id === 'feed-parent')).toMatchObject({ last_fetched_at: null });
  });
});

describe('the page offers Refresh to everyone but a guest', () => {
  const refreshButtons = (html: string) => (html.match(/<\/svg> Refresh<\/button>/g) ?? []).length;
  async function render(): Promise<string> {
    const { ToastProvider } = await import('@/components/ui/toast');
    const { default: Page } = await import('@/app/(app)/dashboard/library/page');
    return renderToStaticMarkup(createElement(ToastProvider, null, await Page()));
  }

  it.each([['user-child', 'child'], ['user-parent', 'parent']])('a %s sees the feed\'s Refresh', async (user, role) => {
    as(user, role);
    expect(refreshButtons(await render())).toBe(1);
  }, 30_000);

  it('a guest sees the feed and no Refresh', async () => {
    as('user-guest', 'guest');
    const html = await render();
    expect(html).toContain('https://parent.test/feed');
    expect(refreshButtons(html)).toBe(0);
  }, 30_000);
});
