import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderTranslated } from './helpers/render-translated';

/**
 * An order step is one the database knows, and the app has one table of them
 * (N19).
 *
 * lib/marketplace/order-lifecycle.ts said its statuses "match the DB check
 * constraints on marketplace_orders exactly" while its ORDER_TRANSITIONS used
 * pending/available/sold/canceled/refunded/disputed — none of which 0151's
 * check allows — and the live flow was a second table in actions.ts
 * (ORDER_FLOW) and a third in order-controls.tsx (NEXT_STEPS). It is now the
 * one table, in the database's vocabulary: the action allows exactly its
 * steps and the Orders page offers exactly its steps.
 *
 * rental-lifecycle.ts and disputes.ts said they "back" tables no migration
 * creates. They are kept as specifications, say so, and nothing outside their
 * own tests may import them, so a future caller cannot validate a write
 * against statuses the database would refuse.
 */
const harness = vi.hoisted(() => ({ db: null as unknown, memberId: 'm-seller' }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: () => undefined, error: () => undefined }) }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: `user-${harness.memberId}` }, memberships: [],
    active: { familyId: 'fam-1', role: 'parent', member: { id: harness.memberId, family_id: 'fam-1' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});

const { ORDER_TRANSITIONS } = await import('@/lib/marketplace/order-lifecycle');
const { setOrderStatusAction } = await import('@/app/(app)/marketplace/actions');
const { OrderControls } = await import('@/components/marketplace/order-controls');

/** marketplace_orders.status as 0151's check constraint spells it. */
const DB_STATUSES = (() => {
  const sql = readFileSync('supabase/migrations/0151_marketplace_v2.sql', 'utf8');
  const orders = sql.slice(sql.indexOf('create table if not exists public.marketplace_orders'));
  const list = /status\s+text not null default 'requested'\s+check \(status in \(([^)]*)\)\)/.exec(orders)?.[1];
  return (list ?? '').split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean).sort();
})();

let db: InMemorySupabase;
beforeEach(() => {
  db = createInMemorySupabase();
  harness.db = db;
  harness.memberId = 'm-seller';
});

describe('the order state machine is the database\'s', () => {
  it('found the check constraint to compare with', () => {
    expect(DB_STATUSES).toEqual(['active', 'cancelled', 'completed', 'confirmed', 'requested', 'returned']);
  });

  it('names every status the database allows, and no other, as a source and as a target', () => {
    expect(Object.keys(ORDER_TRANSITIONS).sort()).toEqual(DB_STATUSES);
    for (const targets of Object.values(ORDER_TRANSITIONS)) {
      for (const to of targets) expect(DB_STATUSES).toContain(to);
    }
  });

  it('setOrderStatusAction takes exactly its steps', async () => {
    for (const from of DB_STATUSES) {
      for (const to of DB_STATUSES) {
        db.replace('marketplace_orders', []);
        db.seed('marketplace_orders', [{ id: 'order-1', family_id: 'fam-1', listing_id: 'l-1', buyer_member: 'm-buyer', seller_member: 'm-seller', kind: 'buy', status: from }]);
        const allowed = (ORDER_TRANSITIONS as Record<string, readonly string[]>)[from].includes(to);
        const res = await setOrderStatusAction('order-1', to);
        expect(res.ok, `${from} → ${to}`).toBe(allowed);
        expect(db.table('marketplace_orders')[0].status, `${from} → ${to}`).toBe(allowed ? to : from);
      }
    }
  });

  it('the Orders page offers the seller exactly its steps', () => {
    for (const from of DB_STATUSES) {
      const html = renderTranslated(createElement(OrderControls, { orderId: 'order-1', status: from, viewerRole: 'seller' }));
      const buttons = html.match(/<button/g)?.length ?? 0;
      expect(buttons, from).toBe((ORDER_TRANSITIONS as Record<string, readonly string[]>)[from].length);
    }
  });
});

/** Every TypeScript file under the app's own source roots. */
function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
  };
  for (const root of ['app', 'components', 'lib', 'mobile', 'scripts']) {
    try { walk(root); } catch { /* a root this checkout does not have */ }
  }
  return out;
}

describe('a marketplace engine with no table behind it says so and has no caller', () => {
  const migrations = readdirSync('supabase/migrations').map((f) => readFileSync(join('supabase/migrations', f), 'utf8')).join('\n');

  it('every lib/marketplace module that says it backs a table names one a migration creates', () => {
    const claims: string[] = [];
    for (const file of readdirSync('lib/marketplace').filter((f) => f.endsWith('.ts'))) {
      const header = readFileSync(join('lib/marketplace', file), 'utf8').split('\n').filter((l) => l.startsWith('//')).join(' ');
      for (const m of header.matchAll(/\bBacks\s+([a-z_]+)/g)) claims.push(`${file}: ${m[1]}`);
    }
    const missing = claims.filter((c) => !new RegExp(`create table (if not exists )?public\\.${c.split(': ')[1]}\\b`).test(migrations));
    expect(missing).toEqual([]);
  });

  it.each(['rental-lifecycle', 'disputes'])('nothing outside its test imports lib/marketplace/%s', (name) => {
    const importers = sources().filter((file) => new RegExp(`marketplace/${name}['"]`).test(readFileSync(file, 'utf8')));
    expect(importers).toEqual([]);
    expect(readFileSync(`lib/marketplace/${name}.ts`, 'utf8')).toContain('NOT WIRED');
  });
});
