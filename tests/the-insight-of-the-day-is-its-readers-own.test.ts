// N9-S2 — Home's one "insight of the day" (T4) is kept in daily_insights, one
// row per family, day and kind (0141: any member selects, inserts and updates
// it). The AI home dashboard built its candidates from the visitor's own reads,
// upserted them over the day's rows, and then showed the top ACTIVE row,
// whoever had written it. So a parent's visit wrote "Mum's passport expires in
// 6 days" (a document 0266 keeps from a child) or a manager-only insurance card,
// and a child's visit was handed it; and a child's visit, whose conflicts are
// only their own, rewrote the household's conflict for the day.
//
// What a reader is shown is now built from what they read; the row is the
// day's record of the kind, for its id and its dismissal. A parent's or an
// adult's visit keeps the household's row; anyone else's only starts a kind
// nobody has written today, and never rewrites one.
//
// Driven through the real AiHomeDashboard over the in-memory database, with the
// child on a client that hides what 0266's documents_select hides from them.
import React, { isValidElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { UserContext } from '@/lib/supabase/auth';
import { getMessages, translate } from '@/lib/i18n/messages';
import { isManager } from '@/lib/constants/roles';
import { isSensitiveDocument } from '@/lib/documents/sensitivity';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

type DB = SupabaseClient<Database>;
const FAMILY = 'f1';
const NOW = '2026-10-14T10:00:00Z';
const h = vi.hoisted(() => ({ db: null as unknown, role: 'parent' }));
const NAMES: Record<string, string> = { parent: 'Mum', child: 'Ava' };

const ctx = () => ({
  user: { id: `u-${h.role}`, email: `${h.role}@example.test` },
  active: {
    familyId: FAMILY, role: h.role,
    member: { id: `m-${h.role}`, display_name: NAMES[h.role] ?? h.role, role: h.role },
    family: { id: FAMILY, name: 'Family', timezone: 'UTC', created_at: '2026-01-01T00:00:00Z' },
  },
});

vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ctx(), requireFeature: async () => ctx(), isSuperAdmin: async () => false }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { getMessages: messages, translate: tr } = await import('@/lib/i18n/messages');
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => tr(messages('en-US'), key, params),
    getLocaleContext: async () => ({ locale: { code: 'en-US' }, source: 'default', messages: messages('en-US') }),
  };
});
// What none of this is about answers as empty.
vi.mock('@/lib/calendar/source-capability', () => ({ get CALENDAR_SOURCE_ARCHIVE_ENABLED() { return false; } }));
vi.mock('@/lib/server/plan', () => ({ resolveFamilyPlanLevel: async () => 1 }));
vi.mock('@/lib/services/approvals', () => ({ listPending: async () => ({ ok: true, data: [] }) }));
vi.mock('@/lib/home/completed', () => ({ loadCompletedByBubaly: async () => ({ ok: true, data: [] }) }));
vi.mock('@/components/i18n/locale-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/i18n/locale-provider')>()),
  useTranslations: () => (key: string, params?: Record<string, string | number>) => translate(getMessages('en-US'), key, params),
  useFamilyTimeZone: () => 'UTC',
}));
vi.mock('next/link', () => ({ default: ({ children, ...props }: React.ComponentProps<'a'>) => React.createElement('a', props, children) }));

const { AiHomeDashboard } = await import('@/components/dashboard/ai-home-dashboard');
const { InsightHero } = await import('@/components/dashboard/insight-hero');

type Shown = { id: string; kind: string; title: string; detail: string; href: string };

let db: InMemorySupabase;

/**
 * The client a member who does not manage the family has: `documents` as
 * 0266's documents_select gives it (is_sensitive_document hides a passport, a
 * policy, a tax return), everything else as it is.
 */
const narrowed = (): DB => new Proxy(db, {
  get(target, property, receiver) {
    if (property !== 'from') return Reflect.get(target, property, receiver);
    return (table: string) => {
      const builder = target.from(table) as unknown as { select: (...args: unknown[]) => { in: (column: string, values: unknown[]) => unknown } };
      if (table !== 'documents') return builder;
      const select = builder.select.bind(builder);
      builder.select = (...args) => {
        const readable = db.table('documents')
          .filter((d) => !isSensitiveDocument({ is_secure: (d.is_secure as boolean | null) ?? null, category: (d.category as string | null) ?? null }))
          .map((d) => d.id);
        return select(...args).in('id', readable) as ReturnType<typeof select>;
      };
      return builder;
    };
  },
}) as unknown as DB;

/** Every string a rendered tree carries in its props, wherever it sits. */
function stringsIn(node: unknown, seen = new Set<unknown>()): string[] {
  if (typeof node === 'string') return [node];
  if (typeof node === 'number') return [String(node)];
  if (!node || typeof node !== 'object' || seen.has(node)) return [];
  seen.add(node);
  if (Array.isArray(node)) return node.flatMap((child) => stringsIn(child, seen));
  const props = isValidElement<Record<string, unknown>>(node) ? node.props : (node as Record<string, unknown>);
  return Object.values(props).flatMap((value) => stringsIn(value, seen));
}

/** The insight the tree hands InsightHero, if any. */
function heroIn(node: ReactNode): Shown | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = heroIn(child);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement<Record<string, unknown>>(node)) return null;
  if (node.type === InsightHero) return (node.props as { insight: Shown }).insight;
  for (const value of Object.values(node.props)) {
    if (value && typeof value === 'object') {
      const found = heroIn(value as ReactNode);
      if (found) return found;
    }
  }
  return null;
}

/** A visit to Home by `role`, on the client they have. */
async function visitAs(role: string) {
  h.role = role;
  h.db = isManager(role) ? db : narrowed();
  const tree = await AiHomeDashboard({ ctx: ctx() as unknown as UserContext }) as ReactNode;
  return { hero: heroIn(tree), text: stringsIn(tree).join('\n') };
}

const rowOf = (kind: string) => db.table('daily_insights').find((r) => r.kind === kind);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  db = createInMemorySupabase({ rpc: { ensure_default_grocery_list: () => 'list-1' }, uniques: { daily_insights: [['family_id', 'as_of_date', 'kind']] } });
  db.seed('families', [{ id: FAMILY, name: 'Family', timezone: 'UTC' }]);
  db.seed('family_members', [
    { id: 'm-parent', family_id: FAMILY, user_id: 'u-parent', display_name: 'Mum', role: 'parent', is_active: true, created_at: '2026-01-01T00:00:00Z' },
    { id: 'm-child', family_id: FAMILY, user_id: 'u-child', display_name: 'Ava', role: 'child', is_active: true, created_at: '2026-01-02T00:00:00Z' },
  ]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('what a parent\'s visit wrote is not what a child is shown', () => {
  const PASSPORT = 'Mum’s passport';
  const DENTAL = 'Renew dental insurance (Smile Co)';

  it.each([
    ['a passport 0266 keeps from them', 'document', PASSPORT, () => db.seed('documents', [
      { id: 'doc-passport', family_id: FAMILY, title: PASSPORT, category: 'Passports', is_secure: false, expires_at: '2026-10-20' },
    ])],
    ['an insurance card that is the managers\'', 'autopilot', DENTAL, () => db.seed('autopilot_suggestions', [
      { id: 'card-dental', family_id: FAMILY, status: 'open', kind: 'insurance', source_kind: 'family_insurance_policies', member_id: null, title: DENTAL, detail: 'Smile Co renews on the 30th.', urgency: 3, confidence: 100, payload: {} },
    ])],
  ])('%s: the parent is shown it, and the child their own insight and nothing of it', async (_case, kind, secret, seed) => {
    seed();

    const parent = await visitAs('parent');
    expect(parent.hero).toMatchObject({ kind, title: expect.stringContaining(secret) });
    expect(rowOf(kind)).toMatchObject({ status: 'active', title: expect.stringContaining(secret) });

    const child = await visitAs('child');
    expect(child.text).not.toContain(secret);
    // Their own: seven dinners this week are not planned, for them as for anyone.
    expect(child.hero).toMatchObject({ kind: 'meal', title: '7 dinners this week aren’t planned' });
    // ...under the day's row, so their dismissal is recorded where it always was.
    expect(child.hero!.id).toBe(rowOf('meal')!.id);
  });

  it('nor is a row only a child\'s reading started shown to the parent as the household\'s', async () => {
    // Ava's own reminder is overdue; a parent's Home lists their own and nobody's.
    db.seed('family_reminders', [{
      id: 'rem-piano', family_id: FAMILY, title: 'Practice piano', remind_at: '2026-10-14T08:00:00Z', status: 'active',
      member_id: 'm-child', priority: 'normal', idempotency_key: null, tags: [],
      autopilot_origin: false, autopilot_card_id: null,
    }]);
    const child = await visitAs('child');
    expect(child.hero).toMatchObject({ kind: 'reminder_overdue', title: '1 reminder slipped past due' });
    expect(rowOf('reminder_overdue')).toMatchObject({ member_id: 'm-child', status: 'active' });
    expect(rowOf('meal')).toMatchObject({ member_id: 'm-child' });

    const parent = await visitAs('parent');

    expect(parent.hero).toMatchObject({ kind: 'meal', id: rowOf('meal')!.id });
    expect(parent.text).not.toContain('slipped past due');
    // The kind the parent read is the household's again.
    expect(rowOf('meal')).toMatchObject({ member_id: null, created_by: 'u-parent' });
  });
});

describe('a child\'s visit does not rewrite the household\'s day', () => {
  // Mum's clash is today, Ava's tomorrow. A parent reads both; Ava only her own.
  const event = (id: string, assignee: string, startsAt: string, endsAt: string) => ({
    id, family_id: FAMILY, title: id, starts_at: startsAt, ends_at: endsAt, all_day: false, assignee_id: assignee,
    location: 'Home', category: 'general', recurrence: 'none',
  });
  beforeEach(() => db.seed('calendar_events', [
    event('Dentist', 'm-parent', '2026-10-14T15:00:00Z', '2026-10-14T16:00:00Z'),
    event('School run', 'm-parent', '2026-10-14T15:30:00Z', '2026-10-14T16:30:00Z'),
    event('Recital', 'm-child', '2026-10-15T16:00:00Z', '2026-10-15T17:00:00Z'),
    event('Swim practice', 'm-child', '2026-10-15T16:30:00Z', '2026-10-15T17:30:00Z'),
  ]));

  it('the parent\'s row for the clash stays as the parent wrote it, and the child is shown their own clash', async () => {
    const parent = await visitAs('parent');
    expect(parent.hero).toMatchObject({ kind: 'conflict', title: 'A schedule clash today', detail: expect.stringContaining('Mum') });
    const household = structuredClone(db.table('daily_insights'));

    const child = await visitAs('child');

    expect(db.table('daily_insights')).toEqual(household);
    expect(child.hero).toMatchObject({ id: rowOf('conflict')!.id, kind: 'conflict', title: 'A schedule clash tomorrow', detail: expect.stringContaining('Ava') });
    expect(child.text).not.toContain('Mum’s day');
  });

  it('a child who is first today starts the day\'s rows, and the parent\'s visit then keeps the household\'s', async () => {
    const child = await visitAs('child');
    expect(child.hero).toMatchObject({ kind: 'conflict', detail: expect.stringContaining('Ava') });
    expect(child.hero!.id).toBe(rowOf('conflict')!.id);

    const parent = await visitAs('parent');

    expect(rowOf('conflict')).toMatchObject({ status: 'active', title: 'A schedule clash today', detail: expect.stringContaining('Mum') });
    expect(parent.hero).toMatchObject({ id: rowOf('conflict')!.id, title: 'A schedule clash today' });
  });

  it('a kind dismissed today is not shown again, nor set back to active, by anyone\'s visit', async () => {
    await visitAs('parent');
    const conflict = rowOf('conflict')!;
    conflict.status = 'dismissed';

    for (const role of ['child', 'parent']) {
      const visit = await visitAs(role);
      expect(visit.hero?.kind).not.toBe('conflict');
      expect(rowOf('conflict')!.status).toBe('dismissed');
    }
  });
});
