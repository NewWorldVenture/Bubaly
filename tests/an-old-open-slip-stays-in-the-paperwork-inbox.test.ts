// S12 — the Paperwork Inbox was the newest 500 rows of any status.
//
// Rows only accumulate: there is no delete path, done and archived rows stay,
// and inbound email attachments and captures file on their own. Past 500, the
// inbox silently lost its OLDEST rows — and the oldest row still in
// needs_action is exactly the slip a family has not dealt with. Its chip count
// went with it, the Needs-you deep link to it landed on nothing, and with no
// needs_action row among the newest 500 the default view read "Inbox zero".
//
// Driven through the real page, against an in-memory household past the cap.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ db: null as unknown, role: 'parent', userId: 'parent-user' }));

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/auth/require-aal2', () => ({ requireAal2: async () => undefined }));
vi.mock('@/lib/supabase/auth', () => {
  const context = async () => ({
    user: { id: h.userId },
    active: { familyId: 'family-1', role: h.role, member: { id: 'member-1' }, family: { timezone: 'UTC' } },
  });
  // The page opens through the Documents feature's gate (requireFeature).
  return { requireUserContext: context, requireFeature: context };
});
// What the page hands the inbox is the question; the module's own rendering is pinned elsewhere.
vi.mock('@/components/modules/paperwork-module', () => ({ PaperworkModule: () => null }));

const { default: PaperworkPage } = await import('@/app/(app)/dashboard/paperwork/page');

type Item = { id: string; status: string; title: string };

async function inboxItems(): Promise<Item[]> {
  const page = (await PaperworkPage()) as ReactElement<{ items?: Item[] }>;
  expect(page.props.items, 'the page rendered its error state instead of the inbox').toBeDefined();
  return page.props.items ?? [];
}

const at = (minutesAgo: number) => new Date(Date.parse('2026-10-13T12:00:00Z') - minutesAgo * 60_000).toISOString();

let db: InMemorySupabase;
beforeEach(() => {
  // PostgREST's own response ceiling, as a default project sets it.
  db = createInMemorySupabase({ maxRows: 1000 });
  h.db = db;
  h.role = 'parent';
  h.userId = 'parent-user';
  db.seed('paperwork_items', [
    { id: 'pw-oldest-open', family_id: 'family-1', title: 'Field trip permission slip', status: 'needs_action', created_by: 'parent-user', created_at: at(100_000) },
    { id: 'pw-old-progress', family_id: 'family-1', title: 'Soccer registration', status: 'in_progress', created_by: 'teen-user', created_at: at(90_000) },
    // Five hundred and one settled items, every one newer than the open two.
    ...Array.from({ length: 501 }, (_, i) => ({
      id: `pw-done-${String(i).padStart(3, '0')}`, family_id: 'family-1', title: `Paid bill ${i}`,
      status: i % 2 ? 'done' : 'archived', created_by: 'parent-user', created_at: at(i + 1),
    })),
  ]);
});

describe('an open slip older than the newest 500 rows is still in the inbox', () => {
  it('a parent sees every open item, and the settled history stays capped', async () => {
    const items = await inboxItems();

    const open = items.filter((item) => item.status === 'needs_action' || item.status === 'in_progress').map((item) => item.id);
    expect(open.sort()).toEqual(['pw-old-progress', 'pw-oldest-open']);
    // So the needs_action chip counts 1 and the default view is not "Inbox zero".
    expect(items.filter((item) => item.status === 'needs_action')).toHaveLength(1);
    expect(items.filter((item) => item.status === 'done' || item.status === 'archived')).toHaveLength(500);
  });

  it('a member narrowed to what they added still sees their own old open item', async () => {
    h.role = 'teen';
    h.userId = 'teen-user';

    const items = await inboxItems();

    expect(items.map((item) => item.id)).toEqual(['pw-old-progress']);
  });

  it('more open items than PostgREST answers in one response are all read', async () => {
    db.seed('paperwork_items', Array.from({ length: 1200 }, (_, i) => ({
      id: `pw-open-${String(i).padStart(4, '0')}`, family_id: 'family-1', title: `Form ${i}`,
      status: 'needs_action', created_by: 'parent-user', created_at: at(200_000 + i),
    })));

    const items = await inboxItems();

    expect(items.filter((item) => item.status === 'needs_action')).toHaveLength(1201);
  });
});
