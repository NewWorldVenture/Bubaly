// The Financial Copilot's insight cards are the household's money warnings, and
// `money_timeline_insights` carries `unique (family_id, dedupe_key)` (0168) —
// ONE status row per family per advisory. So whoever taps Dismiss decides what
// the parents see, not just what they see themselves. Refresh deliberately never
// rewrites `status` (the action's own docstring), and the module has no
// dismissed-items view, so there is no in-app way back.
//
// Two defects met on this path, and both are asserted here as the thing a family
// would notice on the screen rather than as the shape of the code:
//
//   m26 — neither layer checked the role. 0168 gated all four commands on
//   `is_family_member` (membership, no role) and the server action checked
//   nothing, so a child on a kid login or an invited 'guest' could clear the
//   `urgent` low-balance warning for the whole household, permanently for that
//   week. Replayed into a throwaway Postgres with 0003's helpers and 0168's
//   policy text verbatim, a 'child' member flipped the row to 'dismissed' and
//   the PARENT's read-back returned 'dismissed'; a 'guest' then deleted the row
//   outright. A non-member was refused, which is how we know RLS was live.
//
//   m27 — both upserts discarded their `{ error }` and both actions returned
//   `void`, then revalidated unconditionally. A rejected write (a deactivated
//   member, an expired session, a transient PostgREST failure, a database where
//   0168 is not applied) left the card gone for the rest of the page session and
//   back on the next load, with nothing said and nothing logged.
//
// WHAT IS ASSERTED: the page is rendered the way opening it on a phone would,
// the Dismiss is taken through the real server action, and the page is rendered
// AGAIN as the parent. The question each case answers is "is the shortfall
// warning still in front of the parents", not "did a function return a flag".
//
// The forecast loader is the one seam: `loadMoneyTimeline` reads bills, accounts,
// goals and the calendar, none of which this boundary is about, so it is stubbed
// with one fixed urgent advisory. Everything else — the page, the module, both
// actions, the dedupe key, the translator — is the real code.
//
// THE COPY IS THE REAL en-US CATALOGUE, not a map this file supplies. The
// server half translates through the real getTranslations() (only next/headers
// is stubbed, with an en-US locale cookie), and the page is rendered inside the
// real LocaleProvider with getMessages('en-US'). A key the catalogue lacks
// therefore renders as the key — exactly what a family would see — and the
// sentences asserted below are TYPED OUT, never looked up, so a missing entry
// fails instead of matching its own key name. Seven of them are new with this
// change and reach lib/i18n/messages/*.json through the central catalogue merge
// that lands in the same commit. UNTIL THAT MERGE LANDS, the cases that read
// them are red, and that is the point: without it a child's page says
// `moneyTimeline.aParentOrAnotherAdultClearsThese` where a sentence belongs.
//
// The RLS half is proven against a real Postgres by
// docs/audit/a-child-cannot-clear-the-households-money-warnings-check.sql,
// which CI's database job runs after replaying every migration; the last block
// here only pins 0352's shape and that the probe exists.
import { existsSync, readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import type React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import type { CashflowTimeline, TimelineInsight } from '@/lib/finance/timeline';
import { LOCALE_COOKIE, localeOrDefault } from '@/lib/i18n/locales';

const FAMILY = 'fam-money-1';
const WARNING_TITLE = 'Balance runs thin the week of Mar 2';
const DEDUPE_KEY = 'low_balance:2026-03-02';

// ── The English a family reads, typed out (see the header) ──────────────────
// New with this change — red until the catalogue merge lands:
const NOT_YOURS = "Only a parent or another adult can clear the household's money warnings.";
const WHO_CLEARS = 'A parent or another adult clears these notes.';
const COULD_NOT_REFRESH = 'We could not refresh these notes. Please try again.';
const COULD_NOT_READ = 'We could not read that note. Please reload the page and try again.';
const NOT_A_CHOICE = 'That is not a choice we can save.';
const READER_ALL_CAUGHT_UP = 'All caught up — nothing here needs attention right now.';
// Already in the catalogue:
const MANAGER_ALL_CAUGHT_UP = 'All caught up — you’ve cleared every insight. Tap Refresh after adding bills or goals.';
const DISMISS = 'Dismiss';
const GOT_IT = 'Got it';
const REFRESH = 'Refresh';
// describeActionError's own sentence for a 42501 (lib/supabase/errors.ts).
const NO_PERMISSION = /permission/i;

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(),
  createServer: vi.fn(),
  loadMoneyTimeline: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
// Step-up is not a role gate — `needsStepUp` (lib/auth/mfa.ts) returns false for
// anyone who is not a manager, so it never stops the child this test is about.
vi.mock('@/lib/auth/require-aal2', () => ({ requireAal2: async () => {} }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
// The request, not the translator: the real getLocaleContext() reads this
// cookie and resolves en-US exactly as it does in production.
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === LOCALE_COOKIE ? { value: 'en-US' } : undefined) }),
  headers: async () => new Headers(),
}));
vi.mock('@/lib/finance/timeline-load', () => ({ loadMoneyTimeline: mocks.loadMoneyTimeline }));

const MoneyTimelinePage = (await import('@/app/(app)/dashboard/money-timeline/page')).default;
const { setMoneyInsightStatusAction, syncMoneyInsightsAction } =
  await import('@/app/(app)/dashboard/money-timeline/actions');
const { settleWrite, visibleInsights } =
  await import('@/components/modules/money-timeline-module');
const { LocaleProvider } = await import('@/components/i18n/locale-provider');
const { getMessages } = await import('@/lib/i18n/messages');

/** The urgent advisory a parent is relying on. */
const WARNING: TimelineInsight = {
  kind: 'low_balance',
  title: WARNING_TITLE,
  detail: 'At the current pace your balance dips below zero the week of Mar 2.',
  severity: 'urgent',
  weekStart: '2026-03-02',
  amount: -140,
};

/** A second advisory, so a Refresh has more than one row to write. */
const HEAVY_WEEK: TimelineInsight = {
  kind: 'heavy_week',
  title: 'A heavy money week is coming',
  detail: 'Three bills land the week of Mar 9.',
  severity: 'watch',
  weekStart: '2026-03-09',
  amount: 820,
};
const HEAVY_KEY = 'heavy_week:2026-03-09';

function timelineWith(insights: TimelineInsight[]): CashflowTimeline {
  return {
    weeks: [{ weekStart: '2026-03-02', outflow: 820, moments: [], events: [], projectedBalance: -140, heavy: true }],
    startingBalance: 680,
    totalOutflow: 820,
    monthlyRecurring: 310,
    heaviestWeek: null,
    lowestBalance: -140,
    lowestBalanceWeek: '2026-03-02',
    insights,
    planOutflow: 0,
    scenarioOutflow: 0,
    coverage: {
      coveredCount: 0, coveredAmount: 0, openCount: 1, openAmount: 820,
      paidCount: 0, paidAmount: 0, coveredBills: 0, paidBills: 0, openBills: 1, totalBills: 1,
    },
  };
}

let db: ReturnType<typeof createInMemorySupabase>;
let client: unknown;

function signedInAs(role: 'parent' | 'adult' | 'child' | 'teen' | 'guest' | 'caregiver') {
  mocks.requireUserContext.mockResolvedValue({
    user: { id: `user-${role}`, email: `${role}@example.com` },
    memberships: [],
    active: { familyId: FAMILY, family: { id: FAMILY, timezone: 'America/New_York' }, role, member: { id: `mem-${role}` } },
  });
}

/**
 * One load of /dashboard/money-timeline, as the text a phone would paint.
 * The entities are decoded so an assertion can be written in the words a family
 * reads -- "you've", not "you&#x27;ve".
 */
async function openThePage(): Promise<string> {
  const tree = await MoneyTimelinePage();
  // Inside the real provider, with the real en-US catalogue — the way the
  // authenticated app layout hands it down.
  const page = createElement(
    LocaleProvider,
    { locale: localeOrDefault('en-US'), source: 'cookie', messages: getMessages('en-US') } as Parameters<typeof LocaleProvider>[0],
    tree as React.ReactElement,
  );
  return renderToStaticMarkup(page)
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/** The label of every button on the page, as a reader would name it. */
function buttonLabels(html: string): string[] {
  return [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)]
    .map((m) => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

/** The persisted status the whole family's page renders from. */
const persistedStatus = (key = DEDUPE_KEY) =>
  (db.table('money_timeline_insights').find((r) => r.dedupe_key === key)?.status as string | undefined) ?? null;

/**
 * A client whose writes to the insights table are refused the way Postgres
 * refuses them — `{ data: null, error }`, never a throw — for every row
 * `refuses` picks (all of them by default). Everything else, including the
 * rows it does not refuse, goes through the in-memory client untouched.
 */
function withRefusedWrites(
  error: { code: string; message: string },
  refuses: (row: Record<string, unknown>) => boolean = () => true,
) {
  return {
    from(name: string) {
      const builder = db.from(name);
      if (name !== 'money_timeline_insights') return builder;
      const upsert = builder.upsert.bind(builder);
      return Object.assign(builder, {
        upsert: (row: Record<string, unknown>, opts?: { onConflict?: string }) =>
          refuses(row) ? Promise.resolve({ data: null, error }) : upsert(row, opts),
      });
    },
    auth: db.auth,
  };
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  // Silenced for readable output, and kept so a case can assert a refused
  // write was LOGGED — m27's "nothing said and nothing logged".
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase({
    uniques: { money_timeline_insights: [['family_id', 'dedupe_key']] },
    // 0168's column default: Refresh omits `status`, so a new row starts active.
    defaults: { money_timeline_insights: { status: 'active' } },
  });
  client = db;
  mocks.createServer.mockImplementation(async () => client);
  mocks.loadMoneyTimeline.mockImplementation(async () => timelineWith([WARNING]));
});

describe("a child cannot clear the household's money warnings", () => {
  it('leaves the shortfall warning in front of the parents after a child taps Dismiss', async () => {
    signedInAs('parent');
    expect(await openThePage(), 'the parent sees the warning to begin with').toContain(WARNING_TITLE);

    // The child's tap, through the real action.
    signedInAs('child');
    const result = await setMoneyInsightStatusAction({ insight: WARNING, status: 'dismissed' });
    expect(result).toEqual({ ok: false, error: NOT_YOURS });

    // Nothing was written, so nothing changed for anybody.
    expect(persistedStatus(), 'no family-wide status row was written').toBeNull();
    expect(mocks.revalidatePath, 'a refused write does not revalidate the page').not.toHaveBeenCalled();

    // The outcome that matters: the parent opens the page again and the warning
    // is still there, and the page does NOT claim the family is all caught up.
    signedInAs('parent');
    const afterwards = await openThePage();
    expect(afterwards, 'the parents can still see the shortfall warning').toContain(WARNING_TITLE);
    expect(afterwards).not.toContain(MANAGER_ALL_CAUGHT_UP);
  });

  it('refuses a guest, a caregiver and a teen the same way', async () => {
    for (const role of ['guest', 'caregiver', 'teen'] as const) {
      signedInAs(role);
      await expect(
        setMoneyInsightStatusAction({ insight: WARNING, status: 'dismissed' }),
        `${role} dismiss`,
      ).resolves.toEqual({ ok: false, error: NOT_YOURS });
      // Refresh writes the same family-wide rows, so it takes the same role.
      await expect(syncMoneyInsightsAction(), `${role} refresh`).resolves.toEqual({ ok: false, error: NOT_YOURS });
    }
    expect(persistedStatus()).toBeNull();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('shows a child the forecast but not a button that would be refused', async () => {
    signedInAs('child');
    const childsPage = await openThePage();
    // Reading the forecast is a documented product decision (0267's header), so
    // this half must NOT change: the child still sees the warning.
    expect(childsPage, 'the child can still read the forecast').toContain(WARNING_TITLE);
    const childsButtons = buttonLabels(childsPage);
    expect(childsButtons, 'no Dismiss button').not.toContain(DISMISS);
    expect(childsButtons, 'no Got it button').not.toContain(GOT_IT);
    expect(childsButtons, 'no Refresh button').not.toContain(REFRESH);
    expect(childsPage, 'and it says who does clear them').toContain(WHO_CLEARS);

    signedInAs('parent');
    const parentsPage = await openThePage();
    const parentsButtons = buttonLabels(parentsPage);
    expect(parentsButtons, 'a parent still gets the buttons').toEqual(expect.arrayContaining([DISMISS, GOT_IT, REFRESH]));
    expect(parentsPage, 'and is not told someone else clears them').not.toContain(WHO_CLEARS);
  });

  it('still lets a parent clear it for the family', async () => {
    signedInAs('parent');
    await expect(setMoneyInsightStatusAction({ insight: WARNING, status: 'dismissed' })).resolves.toEqual({ ok: true });
    expect(persistedStatus()).toBe('dismissed');
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/dashboard/money-timeline');

    const afterwards = await openThePage();
    expect(afterwards).not.toContain(WARNING_TITLE);
    expect(afterwards).toContain(MANAGER_ALL_CAUGHT_UP);

    // The child's empty page does not tell them they cleared anything, or to
    // tap a Refresh button they do not have.
    signedInAs('child');
    const childsPage = await openThePage();
    expect(childsPage).not.toContain(WARNING_TITLE);
    expect(childsPage).toContain(READER_ALL_CAUGHT_UP);
    expect(childsPage).not.toContain(MANAGER_ALL_CAUGHT_UP);
  });

  it('refuses a payload the copilot never produced, so a future week cannot be pre-dismissed', async () => {
    signedInAs('parent');
    const forged = { ...WARNING, kind: 'made_up_kind', weekStart: '2027-01-04' } as unknown as TimelineInsight;
    const result = await setMoneyInsightStatusAction({ insight: forged, status: 'dismissed' });
    expect(result).toEqual({ ok: false, error: COULD_NOT_READ });
    expect(db.table('money_timeline_insights')).toHaveLength(0);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('refuses a status the page never offers', async () => {
    signedInAs('parent');
    const result = await setMoneyInsightStatusAction({
      insight: WARNING,
      status: 'deleted' as unknown as 'dismissed',
    });
    expect(result).toEqual({ ok: false, error: NOT_A_CHOICE });
    expect(db.table('money_timeline_insights')).toHaveLength(0);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

describe('a dismiss the database refused is not a dismiss the family got', () => {
  const DENIED = { code: '42501', message: 'new row violates row-level security policy for table "money_timeline_insights"' };

  it('says so instead of resolving quietly, logs it, and does not revalidate', async () => {
    signedInAs('parent');
    client = withRefusedWrites(DENIED);

    const result = await setMoneyInsightStatusAction({ insight: WARNING, status: 'dismissed' });
    expect(result.ok, 'a refused write is not a success').toBe(false);
    expect(result.error, 'and the reader is told why in a sentence').toMatch(NO_PERMISSION);
    expect(result.error, 'never the raw Postgres string').not.toContain('row-level security policy');
    expect(consoleError, 'and it is logged, not dropped').toHaveBeenCalled();
    expect(mocks.revalidatePath, 'the page is not revalidated as though something changed').not.toHaveBeenCalled();
  });

  it('reports a Refresh that could not write, rather than a clean refresh', async () => {
    signedInAs('parent');
    client = withRefusedWrites(DENIED);

    const result = await syncMoneyInsightsAction();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(NO_PERMISSION);
    expect(consoleError).toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('writes the rows it can on a partly refused Refresh, shows them, and still reports the failure', async () => {
    signedInAs('parent');
    mocks.loadMoneyTimeline.mockImplementation(async () => timelineWith([WARNING, HEAVY_WEEK]));
    // Only the FIRST row is refused, so a loop that stops there never writes
    // the second one.
    client = withRefusedWrites(DENIED, (row) => row.dedupe_key === DEDUPE_KEY);

    const result = await syncMoneyInsightsAction();
    expect(result.ok, 'a partial refresh is not a clean one').toBe(false);
    expect(result.error).toMatch(NO_PERMISSION);
    expect(persistedStatus(DEDUPE_KEY), 'the refused row was not written').toBeNull();
    expect(persistedStatus(HEAVY_KEY), 'the row after it still was').toBe('active');
    expect(mocks.revalidatePath, 'and the page is revalidated so the row that landed is seen')
      .toHaveBeenCalledWith('/dashboard/money-timeline');
  });

  it('reports a Refresh whose forecast could not be read, and writes nothing', async () => {
    signedInAs('parent');
    mocks.loadMoneyTimeline.mockRejectedValueOnce(new Error('bills read failed'));

    await expect(syncMoneyInsightsAction()).resolves.toEqual({ ok: false, error: COULD_NOT_REFRESH });
    expect(db.table('money_timeline_insights')).toHaveLength(0);
    expect(consoleError).toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('puts the warning back in front of the family when the write did not land', () => {
    // The client half. The optimistic override is a PROMISE that the write
    // landed; when the action says it did not, the card has to come back --
    // otherwise it stays gone for the rest of the page session and returns on
    // the next load with nothing to explain it.
    const cards = [{ ...WARNING, key: DEDUPE_KEY }];
    const persisted: Record<string, string> = {};

    const optimistic = { [DEDUPE_KEY]: 'dismissed' };
    expect(visibleInsights(cards, persisted, optimistic), 'the card goes away on the tap').toHaveLength(0);

    const refused = settleWrite(DEDUPE_KEY, 'active', { ok: false, error: 'Nope.' }, 'fallback');
    expect(visibleInsights(cards, persisted, refused.apply(optimistic)), 'and comes back when the write is refused')
      .toHaveLength(1);
    expect(refused.error, 'with a sentence, not silence').toBe('Nope.');

    // A write that DID land keeps the card gone, and says nothing.
    const kept = settleWrite(DEDUPE_KEY, 'active', { ok: true }, 'fallback');
    expect(visibleInsights(cards, persisted, kept.apply(optimistic))).toHaveLength(0);
    expect(kept.error).toBeNull();

    // A `void`ed promise — the old call shape — is not a success either.
    const voided = settleWrite(DEDUPE_KEY, 'active', undefined, 'We could not save that.');
    expect(visibleInsights(cards, persisted, voided.apply(optimistic))).toHaveLength(1);
    expect(voided.error).toBe('We could not save that.');
  });

  it('settles one card without writing back a stale copy of the others', () => {
    // settleWrite hands React an UPDATER, applied to the overrides as they are
    // when it runs. Another card's override set after this write began must
    // survive this one being rolled back.
    const refused = settleWrite(DEDUPE_KEY, 'active', { ok: false, error: 'Nope.' }, 'fallback');
    const now = { [DEDUPE_KEY]: 'dismissed', [HEAVY_KEY]: 'acknowledged' };
    expect(refused.apply(now)).toEqual({ [DEDUPE_KEY]: 'active', [HEAVY_KEY]: 'acknowledged' });

    const kept = settleWrite(DEDUPE_KEY, 'active', { ok: true }, 'fallback');
    expect(kept.apply(now)).toEqual(now);
  });
});

describe('0352 puts the boundary where a client cannot route around it', () => {
  // An action-only check is not a boundary: `money_timeline_insights` is
  // reachable through PostgREST with the browser's anon key, so RLS is the only
  // thing a crafted request cannot skip. These cases pin the migration's shape;
  // the behaviour is proven by the probe the last case names.
  const raw = readFileSync(
    'supabase/migrations/0352_a_child_cannot_clear_the_households_money_warnings.sql', 'utf8',
  );
  const sql = raw.split('\n').filter((l: string) => !l.trimStart().startsWith('--')).join('\n');

  it('makes the three write commands manager-only', () => {
    for (const cmd of ['insert', 'update', 'delete']) {
      const policy = new RegExp(`create policy money_timeline_insights_${cmd} on public\\.money_timeline_insights\\s+for ${cmd}[\\s\\S]{0,200}?can_manage_family\\(family_id\\)`);
      expect(sql, `${cmd} is manager-only`).toMatch(policy);
    }
    // And not membership-only any more, which is what 0168 left behind.
    expect(sql).not.toMatch(/for (insert|update|delete)[\s\S]{0,120}?is_family_member/);
  });

  it('leaves the read open, because emptying a page is not closing a door', () => {
    expect(sql).toMatch(/for select using \(public\.is_family_member\(family_id\)\)/);
  });

  it('backs it with restrictive guards, so a stray permissive policy cannot reopen it', () => {
    for (const cmd of ['insert', 'update', 'delete']) {
      expect(sql).toMatch(new RegExp(`money_timeline_insights_manager_${cmd}_guard[\\s\\S]{0,80}?as restrictive for ${cmd}`));
    }
    // The sweep must never be able to select its own backstop.
    expect(sql).toMatch(/and p\.polpermissive/);
    expect(sql).not.toMatch(/polpermissive\s+is\s+false/);
  });

  it('closes the anonymous side the guards cannot reach', () => {
    // The guards are `to authenticated`; for anon only the grant layer holds.
    expect(sql).toMatch(/revoke insert, update, delete, truncate on public\.%I from anon/);
    expect(sql).toMatch(/has_table_privilege\('anon'/);
  });

  it('is safe to replay, and asserts its own end state', () => {
    const creates = sql.match(/create policy/g) ?? [];
    const drops = sql.match(/drop policy if exists/g) ?? [];
    expect(drops.length, 'every create is preceded by a guarded drop').toBeGreaterThanOrEqual(creates.length);
    expect(sql).toMatch(/raise exception '0352:/);
    // The select policy is re-asserted before anything is dropped, so no read is
    // ever left uncovered mid-transaction.
    expect(sql.indexOf('for select using')).toBeLessThan(sql.indexOf('from pg_policy p'));
  });

  it('is proven against a real Postgres by a boundary probe CI runs', () => {
    // docs/audit/run-probes.sh globs *-check.sql, so existing is being run.
    const probe = 'docs/audit/a-child-cannot-clear-the-households-money-warnings-check.sql';
    expect(existsSync(probe), `${probe} exists`).toBe(true);
    const body = readFileSync(probe, 'utf8');
    expect(body).toContain('public.money_timeline_insights');
    expect(body, 'and it has been shown to fail without 0352').toMatch(/Negative control/i);
  });
});
