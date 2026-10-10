// A family-wide notice used to be ONE row with user_id NULL. `is_read` is a
// single column, so the first member to read it (a child tapping "mark all
// read") cleared it from every parent's bell and brief, and notify()'s unread
// dedupe then re-created it for everyone on the next run. Driven through the
// real service against a stateful fake, so the read that hides a row is the
// same read that the write changed.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { listUnread, markRead, notify } from '@/lib/services/notifications';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const NOW = new Date('2026-09-06T15:00:00Z');

function family() {
  // 0002: `is_read boolean not null default false`.
  const mem = createInMemorySupabase({ defaults: { notifications: { is_read: false } } });
  mem.seed('family_members', [
    { id: 'm-parent', family_id: 'fam-1', user_id: 'u-parent', role: 'parent', is_active: true },
    { id: 'm-adult', family_id: 'fam-1', user_id: 'u-adult', role: 'adult', is_active: true },
    { id: 'm-child', family_id: 'fam-1', user_id: 'u-child', role: 'child', is_active: true },
  ]);
  mem.seed('notifications', []);
  mem.seed('family_ai_settings', []);
  const db = mem as unknown as SupabaseClient<Database>;
  const scope = (userId: string | null, role: ServiceScope['role'] = 'parent'): ServiceScope => ({
    db, familyId: 'fam-1', userId, memberId: null, role, actorKind: 'system', tz: 'UTC', now: NOW,
  });
  return { mem, scope };
}

async function unreadTitles(scope: ServiceScope): Promise<string[]> {
  const res = await listUnread(scope);
  if (!res.ok) throw new Error(res.error);
  return res.data.map((n) => n.title);
}

describe('family-wide notifications keep read state per member', () => {
  it('a child marking a family notice read leaves it unread for the parents', async () => {
    const { scope } = family();
    const sent = await notify(scope(null), { recipients: 'family', type: 'system', title: 'Approve the gift in Family Wallet' });
    expect(sent.ok).toBe(true);

    const child = scope('u-child', 'child');
    const childRows = await listUnread(child);
    if (!childRows.ok) throw new Error(childRows.error);
    expect(childRows.data).toHaveLength(1);
    expect(await markRead(child, childRows.data[0].id)).toMatchObject({ ok: true });

    expect(await unreadTitles(child)).toEqual([]);
    expect(await unreadTitles(scope('u-parent'))).toEqual(['Approve the gift in Family Wallet']);
    expect(await unreadTitles(scope('u-adult'))).toEqual(['Approve the gift in Family Wallet']);
  });

  it('a member who already read it is not re-notified by the next run while others still have it unread', async () => {
    const { mem, scope } = family();
    await notify(scope(null), { recipients: 'family', type: 'system', title: 'Dinner is at 6' });
    const child = scope('u-child', 'child');
    const rows = await listUnread(child);
    if (!rows.ok) throw new Error(rows.error);
    await markRead(child, rows.data[0].id);

    const again = await notify(scope(null), { recipients: 'family', type: 'system', title: 'Dinner is at 6' });
    expect(again).toMatchObject({ ok: true, data: { created: 1, duplicates: 2 } });
    // The parents still have exactly one copy each; nobody got a second one.
    expect(await unreadTitles(scope('u-parent'))).toEqual(['Dinner is at 6']);
    expect(mem.table('notifications').filter((n) => n.user_id === 'u-parent')).toHaveLength(1);
  });

  it("a manager cannot mark another member's personal notice read", async () => {
    const { scope } = family();
    await notify(scope(null), { recipients: ['m-child'], type: 'chore_due', title: 'Feed the cat' });
    const child = scope('u-child', 'child');
    const rows = await listUnread(child);
    if (!rows.ok) throw new Error(rows.error);

    const byParent = await markRead(scope('u-parent'), rows.data[0].id);
    expect(byParent).toMatchObject({ ok: false, code: 'not_found' });
    expect(await unreadTitles(child)).toEqual(['Feed the cat']);
  });
});

describe('the notifications screen marks read only what it shows this member', () => {
  // RLS (notif_update) lets a manager update ANY row in the family, so the
  // screen's own filter is the only thing between a parent's "mark all read"
  // and every other member's personal notices.
  const source = readFileSync('components/modules/notifications-module.tsx', 'utf8');
  const body = (name: string) => {
    const start = source.indexOf(`async function ${name}(`);
    return source.slice(start, source.indexOf('\n  }\n', start));
  };
  it.each(['markRead', 'markAllRead'])('%s is bounded to this member and family-wide rows', (name) => {
    expect(body(name)).toMatch(/\.update\(\{ is_read: true \}\)[\s\S]*\.or\(`user_id\.eq\.\$\{userId\},user_id\.is\.null`\)/);
  });
});
