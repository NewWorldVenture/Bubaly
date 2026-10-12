import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { UserContext } from '@/lib/supabase/auth';
import type { ServiceScope } from '@/lib/services/types';
import type { SliceEnv } from '@/lib/ai/context/policy';
import { getMessages, translate } from '@/lib/i18n/messages';
import { createInMemorySupabase, withFaults } from './helpers/in-memory-supabase';

// AUD-1031-VISIBLE-PREFIX. Two readers of the family's open Autopilot cards
// took a fixed prefix — Home's panel the twenty most urgent, the assistant's
// proactive context the eight most urgent — and only THEN dropped the cards
// this reader is not shown (lib/autopilot/audience.ts). Twenty insurance cards
// for Ava's policies, which Kit is not shown, left Kit's panel empty, and
// eight did the same to Kit's context, with a card that IS Kit's right behind
// them. Each now applies the reader's rule before it takes its prefix
// (lib/autopilot/visible-prefix.ts). Driven through the real AiHomeDashboard
// and the real proactive slice over the in-memory database.

const mocks = vi.hoisted(() => ({ server: vi.fn() }));
vi.mock('@/lib/calendar/source-capability', () => ({ get CALENDAR_SOURCE_ARCHIVE_ENABLED() { return false; } }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.server }));
vi.mock('@/lib/supabase/auth', () => ({ isSuperAdmin: async () => false }));
vi.mock('@/lib/server/plan', () => ({ resolveFamilyPlanLevel: async () => 1 }));
vi.mock('@/lib/services/approvals', () => ({ listPending: async () => ({ ok: true, data: [] }) }));
vi.mock('@/lib/home/completed', () => ({ loadCompletedByBubaly: async () => ({ ok: true, data: [] }) }));
vi.mock('@/lib/i18n/server', () => ({ getLocaleContext: async () => ({ locale: { code: 'en-US' }, messages: getMessages('en-US') }) }));
vi.mock('@/components/i18n/locale-provider', () => ({ useFamilyTimeZone: () => undefined, useTranslations: () => (key: string, params?: Record<string, string | number>) => translate(getMessages('en-US'), key, params) }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: React.ComponentProps<'a'>) => React.createElement('a', props, children) }));
vi.mock('@/components/concierge/ask-bubaly', () => ({ AskBubaly: () => null }));
vi.mock('@/components/concierge/working-on', () => ({ WorkingOn: () => null }));
vi.mock('@/components/concierge/completed-by-bubaly', () => ({ CompletedByBubaly: () => null }));
vi.mock('@/components/dashboard/quick-actions', () => ({ DashboardQuickActions: () => null }));
vi.mock('@/components/dashboard/insight-hero', () => ({ InsightHero: () => null }));
vi.mock('@/components/approvals/approval-card', () => ({ ApprovalCard: () => null }));
vi.mock('@/components/dashboard/home-approval-actions', () => ({ HomeApprovalActions: () => null }));
vi.mock('@/components/family/record-actions', () => ({ RecommendationActions: () => null }));
vi.mock('@/components/concierge/needs-you-actions', () => ({ FactSuggestionActions: () => null, InboxMessageActions: () => null }));

const { AiHomeDashboard } = await import('@/components/dashboard/ai-home-dashboard');
const { proactiveSlice } = await import('@/lib/ai/context/slices/proactive');

type DB = SupabaseClient<Database>;
type Memory = ReturnType<typeof createInMemorySupabase<DB>>;
const FAMILY = 'f1';
const NOW = '2026-09-21T08:00:00Z';
const ROSTER = [
  { id: 'mum', role: 'parent' }, { id: 'ava', role: 'child' }, { id: 'kit', role: 'child' }, { id: 'neighbour', role: 'guest' },
];
const role = (id: string) => ROSTER.find((m) => m.id === id)!.role;
const KITS_CARD = 'Pack snacks for Saturday’s match';

/** `maxRows`: the server's cap on one response (PostgREST's db-max-rows); none by default. */
function household(maxRows?: number): Memory {
  const db = createInMemorySupabase<DB>(maxRows === undefined ? {} : { maxRows });
  db.seed('families', [{ id: FAMILY, timezone: 'UTC' }]);
  db.seed('family_members', ROSTER.map((m, i) => ({
    ...m, family_id: FAMILY, user_id: `u-${m.id}`, display_name: m.id, is_active: true, birthday: null, created_at: `2026-01-0${i + 1}T00:00:00Z`,
  })));
  return db;
}

/**
 * `hidden` open cards for Ava's dental policies — the managers' and Ava's,
 * never Kit's or the guest's — more urgent than one card for everyone, Kit's
 * team's match snacks.
 */
function seedCards(db: Memory, hidden: number) {
  const card = (id: string, extra: Record<string, unknown>) => ({
    id, family_id: FAMILY, status: 'open', detail: null, action_label: 'Review', payload: {}, dedupe_key: id, action_type: 'create_reminder', ...extra,
  });
  db.seed('autopilot_suggestions', [
    ...Array.from({ length: hidden }, (_, i) => card(`pol-card-${String(i).padStart(2, '0')}`, {
      kind: 'insurance', source_kind: 'family_insurance_policies', source_id: `pol-${i}`, member_id: 'ava',
      title: `Policy ${i} renews in 3 days`, urgency: 3, confidence: 95,
    })),
    card('moment-card', {
      kind: 'moment', source_kind: 'calendar_events', source_id: 'evt-1', member_id: 'kit',
      title: KITS_CARD, urgency: 1, confidence: 60, action_type: 'add_groceries',
    }),
  ]);
}

/** Home as `memberId` sees it: the panel's count and the titles it lists. */
async function homePanelFor(db: Memory, memberId: string) {
  vi.setSystemTime(new Date(NOW));
  mocks.server.mockResolvedValue(db);
  const ctx = {
    user: { id: `u-${memberId}`, email: `${memberId}@example.test` },
    active: { familyId: FAMILY, role: role(memberId), member: { id: memberId, display_name: memberId }, family: { name: 'Family', timezone: 'UTC' } },
  } as unknown as UserContext;
  return renderToStaticMarkup(await AiHomeDashboard({ ctx }));
}

/** The open cards the assistant is handed for `memberId`. */
async function proactiveCardsFor(db: Memory, memberId: string): Promise<string[]> {
  const viewerRole = role(memberId);
  const built = await proactiveSlice.load(
    { db, familyId: FAMILY } as unknown as ServiceScope,
    { tz: 'UTC', now: new Date(NOW), viewer: { role: viewerRole, memberId, canManage: viewerRole === 'parent' }, members: [], pageContext: null } as unknown as SliceEnv,
  );
  if (!built.ok) throw new Error('the proactive slice did not build');
  return (built.data.data as { autopilot: { title: string }[] }).autopilot.map((s) => s.title);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); mocks.server.mockReset(); });

describe("Home's Autopilot panel lists the reader's own cards past twenty hidden ones", () => {
  it('Kit and the guest are listed the card behind twenty of Ava’s policy cards', async () => {
    const db = household();
    seedCards(db, 20);
    for (const reader of ['kit', 'neighbour']) {
      const html = await homePanelFor(db, reader);
      expect(html, reader).toContain(KITS_CARD);
      expect(html, reader).not.toContain('Policy 0 renews');
    }
  });

  it('a manager is listed the twenty most urgent, as before, and Ava her policies', async () => {
    const db = household();
    seedCards(db, 20);
    const parent = await homePanelFor(db, 'mum');
    expect(parent).toContain('Policy 0 renews in 3 days');
    expect(parent).not.toContain(KITS_CARD);
    const ava = await homePanelFor(db, 'ava');
    expect(ava).toContain('Policy 0 renews in 3 days');
  });

  it('a reader with nothing hidden ahead of them reads one page, as before', async () => {
    const db = household();
    seedCards(db, 0);
    expect(await homePanelFor(db, 'kit')).toContain(KITS_CARD);
  });
});

describe("the assistant's proactive context holds the reader's own cards past eight hidden ones", () => {
  it('Kit and the guest are handed the card behind eight of Ava’s policy cards', async () => {
    const db = household();
    seedCards(db, 8);
    for (const reader of ['kit', 'neighbour']) expect(await proactiveCardsFor(db, reader), reader).toEqual([KITS_CARD]);
  });

  it('a manager is handed the eight most urgent, as before', async () => {
    const db = household();
    seedCards(db, 8);
    const parent = await proactiveCardsFor(db, 'mum');
    expect(parent).toHaveLength(8);
    expect(parent).not.toContain(KITS_CARD);
  });

  it('past more hidden cards than one page holds, still the reader’s own', async () => {
    const db = household();
    seedCards(db, 30);
    expect(await proactiveCardsFor(db, 'kit')).toEqual([KITS_CARD]);
    const html = await homePanelFor(db, 'kit');
    expect(html).toContain(KITS_CARD);
  });
});

// AUD-1031-VISIBLE-PREFIX, R5. A page the server capped ended the read: asked
// for rows 8–23 after eight hidden ones, a server capping every response at
// eight (db-max-rows) answered 8–15, and eight rows where sixteen were asked
// read as the end, so the card at row 16 was never read. A page now starts
// where the rows actually returned end, and only an empty page ends the read
// (lib/autopilot/visible-prefix.ts). Home and Calm (tests/a-cards-reminder-in-
// calm-and-the-briefs-is-listed-only-to-its-readers.test.ts) share the helper.
describe('a page the server capped is not the end of the read', () => {
  /** The same database, recording the range of each page of open cards read. */
  function recordingPages(db: Memory) {
    const pages: unknown[] = [];
    const client = withFaults(db, (table, calls) => {
      const range = calls.find((c) => c.method === 'range');
      if (table === 'autopilot_suggestions' && range) pages.push(range.args);
      return null;
    });
    return { client, pages };
  }

  it("the assistant's context: past sixteen hidden cards from a server capping at eight, Kit is handed his own; a manager's eight are one round trip, in order", async () => {
    const db = household(8);
    seedCards(db, 16);
    const kit = recordingPages(db);
    expect(await proactiveCardsFor(kit.client, 'kit')).toEqual([KITS_CARD]);
    // Each page from where the last one's rows ended, twice as many asked;
    // the end is the empty page after the card at row 16.
    expect(kit.pages).toEqual([[0, 7], [8, 23], [16, 47], [17, 80]]);
    const mum = recordingPages(db);
    expect(await proactiveCardsFor(mum.client, 'mum')).toEqual(Array.from({ length: 8 }, (_, i) => `Policy ${i} renews in 3 days`));
    expect(mum.pages).toEqual([[0, 7]]);
  });

  it("Home's panel: past forty hidden cards from a server capping at twenty, Kit and the guest are listed their own", async () => {
    const db = household(20);
    seedCards(db, 40);
    for (const reader of ['kit', 'neighbour']) {
      const html = await homePanelFor(db, reader);
      expect(html, reader).toContain(KITS_CARD);
      expect(html, reader).not.toContain('Policy 0 renews');
    }
    expect(await homePanelFor(db, 'mum')).toContain('Policy 0 renews in 3 days');
  });

  it('a page that fails after a capped one fails the read, as the one query would', async () => {
    const db = household(8);
    seedCards(db, 16);
    const failing = withFaults(db, (table, calls) => (table === 'autopilot_suggestions'
      && calls.some((c) => c.method === 'range' && c.args[0] === 16) ? { message: 'Fixture page refused' } : null));
    const built = await proactiveSlice.load(
      { db: failing, familyId: FAMILY } as unknown as ServiceScope,
      { tz: 'UTC', now: new Date(NOW), viewer: { role: 'child', memberId: 'kit', canManage: false }, members: [], pageContext: null } as unknown as SliceEnv,
    );
    expect(built.ok).toBe(false);
    expect(JSON.stringify(built)).not.toContain('Fixture page refused');
  });
});

describe('a read that never comes back empty still ends', () => {
  // The read now ends on an empty page, not a short one, so a page that
  // ignores its range — and never comes back empty — is a runaway: it is
  // read through VISIBLE_PREFIX_SCAN_LIMIT rows, from where each page's rows
  // end, and answered with what was kept (lib/autopilot/visible-prefix.ts).
  it('the card prefix and the reminder prefix read no further than VISIBLE_PREFIX_SCAN_LIMIT rows', async () => {
    const { readVisiblePrefix, VISIBLE_PREFIX_SCAN_LIMIT } = await import('@/lib/autopilot/visible-prefix');
    const { readVisibleReminders } = await import('@/lib/autopilot/reminder-cards');
    const pageStarts = Array.from({ length: VISIBLE_PREFIX_SCAN_LIMIT / 1000 }, (_, i) => i * 1000);

    const cards = Array.from({ length: 1000 }, (_, i) => ({ id: `hidden-${i}` }));
    const cardPages: number[] = [];
    expect(await readVisiblePrefix(async (from: number) => { cardPages.push(from); return { data: cards, error: null }; }, { limit: 8, visible: () => false }))
      .toEqual({ data: [], error: null });
    expect(cardPages).toEqual(pageStarts);

    // A scan reminder no card answers is the managers' alone: hidden from Kit.
    const reminders = Array.from({ length: 1000 }, (_, i) => ({ id: `r-${i}`, related_type: 'renewal', related_id: `ren-${i}` }));
    const reminderPages: number[] = [];
    expect(await readVisibleReminders(async (from: number) => { reminderPages.push(from); return { data: reminders, error: null }; }, {
      limit: 8, viewer: { role: 'child', memberId: 'kit' }, cards: async () => null,
    })).toEqual({ data: [], error: null });
    expect(reminderPages).toEqual(pageStarts);
  });

  it('a server answering one row at a time is read through VISIBLE_PREFIX_SCAN_LIMIT rows, each page asking for no more than that', async () => {
    const { readVisiblePrefix, VISIBLE_PREFIX_SCAN_LIMIT } = await import('@/lib/autopilot/visible-prefix');
    const asked: [number, number][] = [];
    const read = await readVisiblePrefix(async (from: number, to: number) => {
      asked.push([from, to]);
      return { data: [{ id: `hidden-${from}` }], error: null };
    }, { limit: 8, visible: () => false });
    expect(read).toEqual({ data: [], error: null });
    expect(asked.map(([from]) => from)).toEqual(Array.from({ length: VISIBLE_PREFIX_SCAN_LIMIT }, (_, i) => i));
    expect(asked.slice(0, 4)).toEqual([[0, 7], [1, 16], [2, 33], [3, 66]]);
    expect(Math.max(...asked.map(([from, to]) => to - from + 1))).toBe(VISIBLE_PREFIX_SCAN_LIMIT);
  });
});
