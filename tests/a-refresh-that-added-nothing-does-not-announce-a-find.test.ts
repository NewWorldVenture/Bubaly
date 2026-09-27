// "Find new insights" on /dashboard/playbook told the family a number, and the
// number was the CANDIDATE count, not the count of cards that appeared.
//
// `refreshPlaybookAction` re-derives suggestions from the household every press.
// `learnPlaybook` is deterministic over signatures that are stable functions of
// the data (`meal:taco-night`, `tradition:christmas-eve-dinner`, …), the write is
// `upsert(..., { ignoreDuplicates: true })` — `ON CONFLICT (family_id, signature)
// DO NOTHING`, supabase/migrations/0126_family_playbook.sql:31 — and an accepted
// or dismissed card KEEPS its row (confirmFact / forgetFact only move `status`;
// `clearAiMemory` only deletes `ai_memory:%` signatures; nothing expires them).
//
// So a family that worked its inbox down to nothing pressed the empty state's own
// button and read "Found 3 things Bubaly noticed" over "Nothing to review right
// now — To review: 0". Forever: nothing ever frees those signatures again. The one
// branch that would have been true, "No new patterns yet — check back after more
// activity" (components/modules/playbook-module.tsx, the `res.added` falsy arm),
// was unreachable while the household had any pattern at all.
//
// The number has to come from the database. `.select('id')` on the upsert asks
// for `Prefer: return=representation`, and RETURNING on DO NOTHING yields only
// the rows actually inserted.
//
// These cases drive the real action against the shared in-memory PostgREST fake
// (tests/helpers/in-memory-supabase.ts), which models both halves faithfully: a
// conflicting row is skipped, and a write without `.select()` answers
// `data: null` the way the real client does.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({ requireUserContext: vi.fn(), createServer: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
// The REAL en-US catalogue, not an identity translator: a message the catalogue
// does not carry must fail here, not pass as its own key.
vi.mock('@/lib/i18n/server', async () => {
  const { getMessages, translate } = await import('@/lib/i18n/messages');
  const messages = getMessages('en-US');
  return {
    getLocaleContext: async () => ({ locale: { code: 'en-US' }, source: 'default', messages }),
    getTranslations: async () => (key: string, params?: Record<string, string | number>) =>
      translate(messages, key, params),
  };
});

const { refreshPlaybookAction } = await import('@/app/(app)/dashboard/playbook/playbook-actions');

const FAMILY = 'fam-1';
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

let db: InMemorySupabase;

/**
 * The sentence the parent actually reads, from `onRefresh` in
 * components/modules/playbook-module.tsx. `added` is the only input it has.
 */
function toastFor(added: number | undefined): string {
  return added
    ? `Found ${added} thing${added === 1 ? '' : 's'} Bubaly noticed`
    : 'No new patterns yet — check back after more activity';
}

/** The cards the inbox will actually show — the "To review" tile's number. */
const reviewable = () =>
  db.table('family_playbook_suggestions').filter((r) => r.status === 'suggested');

const allCards = () => db.table('family_playbook_suggestions');

/**
 * A settled household with exactly three durable patterns: 12 taco dinners on
 * the plan (`meal`, threshold 3), five cartons of oat milk (`grocery`,
 * threshold 4) and a dinner held three Decembers running (`tradition`,
 * threshold 2 years). Dates are relative to now so the fixture cannot rot.
 */
function seedHousehold(): void {
  db.seed('meal_plans', Array.from({ length: 12 }, (_, i) => ({
    id: `plan-${i}`, family_id: FAMILY, meal_id: 'meal-taco', plan_date: daysAgo(i * 7).slice(0, 10),
  })));
  db.seed('meals', [{ id: 'meal-taco', family_id: FAMILY, name: 'Taco night' }]);
  db.seed('grocery_items', Array.from({ length: 5 }, (_, i) => ({
    id: `groc-${i}`, family_id: FAMILY, name: 'Oat milk', created_at: daysAgo(i * 10),
  })));
  db.seed('calendar_events', [30, 395, 760].map((ago, i) => ({
    id: `evt-${i}`, family_id: FAMILY, title: 'Christmas Eve Dinner',
    starts_at: daysAgo(ago), recurrence: null,
  })));
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase({
    uniques: { family_playbook_suggestions: [['family_id', 'signature']] },
    defaults: { family_playbook_suggestions: { status: 'suggested', confidence: 50, fact_id: null, expires_at: null } },
    userId: 'user-1',
  });
  seedHousehold();
  mocks.requireUserContext.mockResolvedValue({ user: { id: 'user-1' }, active: { familyId: FAMILY } });
  mocks.createServer.mockResolvedValue(db);
});

describe('what "Find new insights" tells the family it found', () => {
  it('announces the cards the first press actually put in the inbox', async () => {
    const res = await refreshPlaybookAction();

    expect(res.ok).toBe(true);
    expect(reviewable()).toHaveLength(3);
    expect(res.added, 'the count announced is the count of cards to review').toBe(reviewable().length);
    expect(toastFor(res.added)).toBe('Found 3 things Bubaly noticed');
  });

  it('says no new patterns when the second press over an unchanged household added nothing', async () => {
    await refreshPlaybookAction();
    const before = allCards().length;

    const res = await refreshPlaybookAction();

    expect(res.ok).toBe(true);
    expect(allCards(), 'ON CONFLICT DO NOTHING skipped every regenerated signature').toHaveLength(before);
    expect(res.added, 'nothing was added, so nothing may be announced').toBe(0);
    expect(toastFor(res.added)).toBe('No new patterns yet — check back after more activity');
  });

  it('does not claim a find over the empty state a family has already cleared', async () => {
    // The family's first press stocks three cards; they save two to the
    // Knowledge Base and dismiss the third. The inbox is empty, and every one of
    // those three signatures is still occupied.
    await refreshPlaybookAction();
    const [first, second, third] = allCards();
    first.status = 'accepted';
    second.status = 'accepted';
    third.status = 'dismissed';
    expect(reviewable(), 'the inbox is empty before the press').toHaveLength(0);

    const res = await refreshPlaybookAction();

    // What the screen says underneath and what the toast says on top must agree.
    expect(reviewable(), 'still nothing to review after the press').toHaveLength(0);
    expect(res.added).toBe(0);
    expect(toastFor(res.added)).toBe('No new patterns yet — check back after more activity');
    expect(allCards().map((r) => r.status).sort(), 'no card was resurrected or duplicated')
      .toEqual(['accepted', 'accepted', 'dismissed']);
  });

  it('counts only what is new when the household has grown since the last press', async () => {
    await refreshPlaybookAction();
    for (const card of allCards()) card.status = 'dismissed';
    // One new durable pattern: a second dinner planned often enough to qualify.
    db.seed('meals', [{ id: 'meal-chili', family_id: FAMILY, name: 'Chili night' }]);
    db.seed('meal_plans', Array.from({ length: 4 }, (_, i) => ({
      id: `plan-chili-${i}`, family_id: FAMILY, meal_id: 'meal-chili', plan_date: daysAgo(i * 3).slice(0, 10),
    })));

    const res = await refreshPlaybookAction();

    expect(res.added, 'one new pattern, one announced').toBe(1);
    expect(toastFor(res.added)).toBe('Found 1 thing Bubaly noticed');
    expect(reviewable().map((r) => r.signature)).toEqual(['meal:chili-night']);
  });

  it('refuses to invent a count when the write came back without its representation', async () => {
    // A write that answers `{ data: null, error: null }` cannot be counted.
    // Reporting 0 (or the candidate count) would be the same lie with a
    // friendlier face, so the action says it could not tell.
    //
    // Every read goes to the real fake. The suggestion write runs too — as the
    // fake's BARE upsert, which lands the rows and answers `data: null` — so only
    // the representation is lost, never the write.
    mocks.createServer.mockResolvedValue({
      from: (table: string) => table !== 'family_playbook_suggestions' ? db.from(table) : {
        upsert: (rows: Row[], opts: { onConflict?: string; ignoreDuplicates?: boolean }) => ({
          select: () => db.from(table).upsert(rows, opts),
        }),
      },
    });

    const res = await refreshPlaybookAction();

    expect(res.ok, 'an uncountable write is not a success').toBe(false);
    expect(res.added, 'no number is offered at all').toBeUndefined();
    expect(reviewable(), 'the copy says Bubaly saved what it learned — it did').toHaveLength(3);
    // The English sentence, from the real en-US catalogue. RED until the
    // orchestrator's i18n merge adds `playbookActions.couldNotCountNewInsights`
    // (scratchpad i18n-asks/m30.json) — until then the action returns the raw
    // key, which is exactly the gap this assertion exists to catch.
    expect(res.error).toBe(
      'Bubaly saved what it learned, but could not tell how much of it was new. Reload the page to see your inbox.',
    );
  });
});

/** The signatures learnPlaybook derives are stable — that is why they all conflict. */
it('regenerates the same signatures on every press, which is why the count must come from the database', async () => {
  await refreshPlaybookAction();
  const sigs = allCards().map((r: Row) => r.signature).sort();
  await refreshPlaybookAction();

  expect(allCards().map((r: Row) => r.signature).sort()).toEqual(sigs);
  expect(sigs).toEqual(['grocery:oat-milk', 'meal:taco-night', 'tradition:christmas-eve-dinner']);
});
