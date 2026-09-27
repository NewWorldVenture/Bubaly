// I18N-003 (finalaudit.md AQ-01), the engines-and-digests group: Autopilot's
// subscription suggestions, Family Intelligence's budget drift, the Decision
// Engine's budget breach (and Group Voting, which carries it), the Food Health
// Score's budget line, and a chore's cash reward on the kid's submit page and
// the parent's review card.
//
// Every one wrote the currency symbol as TEXT —
//
//   `$${(cents / 100).toFixed(2)}`        `$${v.toLocaleString('en-US')}`
//
// — so a German parent read "$2768.50" or "$2,768.50": the American symbol
// position, and either no grouping or America's. And the amount sat inside an
// English sentence, so localising the number alone would have changed nothing a
// German family could read.
//
// So each case runs the real code a reader reaches — the Autopilot scan and the
// signal detection writing their rows into a Supabase stand-in, the Autopilot,
// Decisions and review-card components and the Calm, Family Intelligence and
// kid-submit pages rendered, the reasoning report loaded — for a de-DE reader,
// and asserts both halves of what that reader gets: the amount in their format,
// AND no English sentence left around it. The same call for en-US must produce
// the exact English sentence the catalogue is asked to hold.
//
// RED UNTIL THE CATALOGUE MERGE LANDS. The sentences come from the REAL
// catalogues — no English floor layered under them — and the keys are asked for
// in the orchestrator's i18n asks (engines-and-digests.json, and family-modules
// .json for the votingConsensus.* sentences Group Voting wraps the breach in).
// Until they are merged a key renders as itself, and every case below fails on
// it: that is the point. A test that filled the gap with its own English would
// pass on a screen that shows "autopilotEngine.subscriptionCharge".
//
// THE STORED WORDS ARE NOT WHAT A READER SEES. Two writers are crons with no
// reader at all (I18N-001: no stored family or member locale), so they store
// en-US, and a later scan never rewrites a stored Autopilot title (scan.ts skips
// an existing dedupe key). The cases marked "written by the cron" pin that each
// surface words that row again for ITS reader — from payload.titleFacts
// (Autopilot) or evidence (budget drift) — instead of showing it as stored.
//
// THE FOOD SCORE CASE IS THE EXCEPTION, and says so: no production path reaches
// that line today (see computeFoodScore in lib/food/score.ts), so it calls the
// pure function directly with a budget nothing supplies yet.
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Database } from '@/lib/database.types';
import { LocaleProvider } from '@/components/i18n/locale-provider';
import { getMessages, translate } from '@/lib/i18n/messages';
import { localeOrDefault, type LocaleCode } from '@/lib/i18n/locales';
import enUS from '@/lib/i18n/messages/en-US.json';
import deDE from '@/lib/i18n/messages/de-DE.json';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

// ── The catalogue half ───────────────────────────────────────────────────────
// Every sentence this unit moved into the catalogue, in the English it asked for.
const ASKED_ENGLISH: Record<string, string> = {
  'kidsSubmit.upToAmount': 'up to {amount}',
  'kidsSubmit.upToPoints': 'up to {points} pts',
  'missionsReviewCard.suggestsAmount': 'Suggests: {amount}',
  'missionsReviewCard.suggestsPoints': 'Suggests: {points} pts',
  'foodScore.budgetDetail': '{planned} of {budget} budget',
  'decisionEngine.overBudgetBy': 'over budget by {amount}',
  'decisionEngine.overTravelLimit': '{minutes} min over the travel limit',
  'decisionEngine.doesNotFit': "Doesn't fit: {reasons}.",
  'decisions.budgetAmount': 'Budget {amount}',
  'hardSignals.budgetDriftTitle': 'Over budget on {category}',
  'hardSignals.budgetDrift.weekly': 'Spent {spent} of your {limit} weekly {category} budget this period.',
  'hardSignals.budgetDrift.monthly': 'Spent {spent} of your {limit} monthly {category} budget this period.',
  'hardSignals.budgetDrift.yearly': 'Spent {spent} of your {limit} yearly {category} budget this period.',
  'hardSignals.budgetDriftRecurring.weekly': 'Spent {spent} of your {limit} weekly {category} budget — over two weekly periods running.',
  'hardSignals.budgetDriftRecurring.monthly': 'Spent {spent} of your {limit} monthly {category} budget — over two monthly periods running.',
  'hardSignals.budgetDriftRecurring.yearly': 'Spent {spent} of your {limit} yearly {category} budget — over two yearly periods running.',
  'autopilotEngine.subscriptionCharge': '{amount} charge: {name} {when}',
  'autopilotEngine.subscriptionUnused': 'Unused: {name} — {amount}/mo',
};
// Group Voting's own sentences around the breach belong to the family-modules
// unit; this file needs only that German has them.
const BORROWED_KEYS = ['votingConsensus.favoriteDoesNotFitClosestPick'];

const readerFor = (code: LocaleCode) => ({
  locale: code,
  t: (key: string, params?: Record<string, string | number>) => translate(getMessages(code), key, params),
});

// ── The money half ───────────────────────────────────────────────────────────
/** What Intl writes for USD in `locale`, whole amounts without cents — the formatter's own answer, not a typed literal. */
const usd = (cents: number, locale: LocaleCode) => {
  const digits = cents % 100 === 0 ? 0 : 2;
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(cents / 100);
};
/** Intl puts a NO-BREAK SPACE between a German amount and its symbol; compare as plain text. */
const plain = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ');
/** Every American rendering of 2768.50 the old code could produce. */
const AMERICAN = ['$2,768.50', '$2768.50', '$2769', '$2,769'];
const expectGerman = (text: string, cents = 276850) => {
  expect(plain(text)).toContain(plain(usd(cents, 'de-DE')));
  for (const us of AMERICAN) expect(plain(text)).not.toContain(us);
};
/** And no English sentence left around it. */
const expectNoEnglish = (text: string, ...english: string[]) => {
  for (const words of english) expect(plain(text), `"${words}" is English left on a German screen`).not.toContain(words);
};

// ── What the rendered surfaces need that is not the code under test ─────────
const h = vi.hoisted(() => ({
  locale: 'de-DE' as string,
  tables: {} as Record<string, unknown[]>,
  db: null as unknown,
}));
vi.mock('@/app/(app)/missions/actions', () => ({ approveSubmissionAction: vi.fn(), rejectSubmissionAction: vi.fn() }));
vi.mock('@/app/(app)/kids/submit/[assignmentId]/submit-form', () => ({ SubmitProofForm: () => null }));
vi.mock('@/app/(app)/dashboard/autopilot/actions', () => ({ resolveAutopilotSuggestionAction: vi.fn() }));
vi.mock('@/app/(app)/dashboard/trust/actions', () => ({ acceptPolicySuggestionAction: vi.fn() }));
vi.mock('@/app/(app)/dashboard/family-signals/actions', () => ({ refreshSignalsAction: vi.fn(), setSignalStatusAction: vi.fn() }));
vi.mock('@/components/app/app-context', () => ({ useApp: () => ({ familyId: 'f1', userId: 'u1', role: 'parent', selfMember: { id: 'm1' } }) }));
vi.mock('@/lib/hooks/use-realtime-query', () => ({
  useRealtimeQuery: ({ table }: { table: string }) => ({
    data: h.tables[table] ?? [], loading: false, error: null, refresh: async () => undefined,
  }),
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: () => undefined, error: () => undefined }) }));
vi.mock('@/components/ui/modal', () => ({ Modal: () => null }));
// An async server component (its own precision read), which a static render
// cannot await; the signal list is what this file is about.
vi.mock('@/components/metrics/signal-precision-card', () => ({ SignalPrecisionCard: () => null }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'u1' }, active: { familyId: 'f1', family: { timezone: 'UTC' } } }),
}));
// A server page asks the request for its reader; here the reader is whoever the
// case says it is, off the real catalogue.
vi.mock('@/lib/i18n/server', async () => {
  const { getMessages: catalogue, translate: lookup } = await import('@/lib/i18n/messages');
  const { localeOrDefault: toLocale } = await import('@/lib/i18n/locales');
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => lookup(catalogue(h.locale as LocaleCode), key, params),
    getLocaleContext: async () => ({ locale: toLocale(h.locale), source: 'cookie', messages: catalogue(h.locale as LocaleCode) }),
  };
});

import { runAutopilotScan } from '@/lib/autopilot/scan';
import { autopilotTitleFor } from '@/lib/autopilot/engine';
import { runSignalDetection } from '@/lib/intelligence/hard-signals-server';
import { loadReasoningReport } from '@/lib/reasoning/engine-server';
import { proactiveSlice, type ProactiveSliceData } from '@/lib/ai/context/slices/proactive';
import type { SliceEnv } from '@/lib/ai/context/policy';
import type { ServiceScope } from '@/lib/services/types';
import { evaluateDecision } from '@/lib/decisions/engine';
import { facilitateConsensus } from '@/lib/voting/consensus';
import { computeFoodScore, type FoodScoreInput } from '@/lib/food/score';
import { fmtCash } from '@/lib/chores/logic';
import { AutopilotModule } from '@/components/modules/autopilot-module';
import { DecisionsModule } from '@/components/modules/decisions-module';
import { ReviewCard, type ReviewItem } from '@/app/(app)/missions/review-card';
import SubmitProofPage from '@/app/(app)/kids/submit/[assignmentId]/page';
import CalmPage from '@/app/(app)/dashboard/calm/page';
import FamilySignalsPage from '@/app/(app)/dashboard/family-signals/page';

const NOW = new Date('2026-09-26T12:00:00.000Z'); // a Saturday; the family is on UTC
type DB = SupabaseClient<Database>;

/** The reader's REAL catalogue, as the app hands it to the provider — no floor under it. */
const withProvider = (code: LocaleCode, node: ReactNode): string => {
  // Annotated, not cast: the provider's props are checked, children included.
  const props: Parameters<typeof LocaleProvider>[0] = {
    locale: localeOrDefault(code), source: 'cookie', messages: getMessages(code), children: node,
  };
  return renderToStaticMarkup(createElement(LocaleProvider, props));
};

beforeEach(() => { h.locale = 'de-DE'; h.tables = {}; h.db = null; });

describe('the catalogue holds every sentence this unit moved into it', () => {
  it.each(Object.entries(ASKED_ENGLISH))('en-US says %s as "%s"', (key, english) => {
    expect((enUS as Record<string, string>)[key]).toBe(english);
  });
  it.each([...Object.keys(ASKED_ENGLISH), ...BORROWED_KEYS])('de-DE carries its own %s', (key) => {
    expect(Object.prototype.hasOwnProperty.call(deDE, key), `${key} would fall back to English for a German reader`).toBe(true);
  });
});

// ── Autopilot ────────────────────────────────────────────────────────────────
const autopilotDb = () => {
  const db = createInMemorySupabase<DB>({ uniques: { autopilot_suggestions: [['family_id', 'dedupe_key']] } });
  db.seed('subscriptions_tracked', [{
    id: 's1', family_id: 'f1', name: 'Netflix', cost_cents: 276850, cadence: 'monthly',
    // Charged tomorrow, and not used since July: both money suggestions fire.
    next_charge: '2026-09-27', last_used: '2026-07-01', status: 'active',
  }]);
  return db;
};
const scanAs = async (db: InMemorySupabase, code: LocaleCode) => {
  const { locale, t } = readerFor(code);
  await runAutopilotScan(db as unknown as DB, 'f1', 'u1', 'UTC', locale, t, NOW);
  const rows = db.table('autopilot_suggestions');
  const title = (prefix: string) => String(rows.find((row) => String(row.dedupe_key).startsWith(prefix))?.title ?? '');
  return { rows, charge: title('sub-charge:'), unused: title('sub-stale:') };
};

describe('Autopilot words a subscription suggestion for its reader', () => {
  it('a German member\'s Rescan stores "… 2.768,50 $ … morgen", with no English around it', async () => {
    const { charge, unused } = await scanAs(autopilotDb(), 'de-DE');
    expectGerman(charge);
    expect(charge).toContain('Netflix');
    expect(charge).toContain('morgen');
    expectNoEnglish(charge, 'charge', 'tomorrow');
    expectGerman(unused);
    expectNoEnglish(unused, 'Unused', '/mo');
  });

  it('an American one stores the catalogue\'s English sentence', async () => {
    const { charge, unused } = await scanAs(autopilotDb(), 'en-US');
    expect(charge).toBe(`${usd(276850, 'en-US')} charge: Netflix tomorrow`);
    expect(unused).toBe(`Unused: Netflix — ${usd(276850, 'en-US')}/mo`);
  });

  it('a row written by the cron in en-US reads German on the Autopilot screen', async () => {
    // app/api/cron/autopilot-scan/route.ts has no reader and stores en-US; the
    // 06:30 UTC run is almost always the first writer, and a later Rescan skips
    // the dedupe key it already holds.
    const db = autopilotDb();
    const { rows, charge } = await scanAs(db, 'en-US');
    expect(charge).toContain(usd(276850, 'en-US'));
    const germanRescan = await scanAs(db, 'de-DE');
    expect(germanRescan.charge, 'the Rescan did not rewrite the stored title').toBe(charge);

    h.tables = { autopilot_suggestions: rows };
    const html = withProvider('de-DE', createElement(AutopilotModule));
    expectGerman(html);
    expect(html).toContain('morgen');
    expectNoEnglish(html, 'charge: Netflix', 'Unused: Netflix');
    // And it says the same thing to an American reading the same row.
    const american = withProvider('en-US', createElement(AutopilotModule));
    expect(american).toContain(`${usd(276850, 'en-US')} charge: Netflix tomorrow`);
  });

  it('and on the Calm page', async () => {
    const db = autopilotDb();
    await scanAs(db, 'en-US');
    h.db = db;
    h.locale = 'de-DE';
    const html = withProvider('de-DE', await CalmPage());
    expectGerman(html);
    expectNoEnglish(html, 'charge: Netflix', 'Unused: Netflix');
  });

  it('a row stored before the facts were keeps its stored words rather than inventing any', () => {
    const { locale, t } = readerFor('de-DE');
    expect(autopilotTitleFor({ title: 'Unused: Netflix — $2,769/mo', payload: { subscriptionId: 's1' } }, locale, t))
      .toBe('Unused: Netflix — $2,769/mo');
  });
});

// ── Family Intelligence ──────────────────────────────────────────────────────
const signalsDb = () => {
  const db = createInMemorySupabase<DB>({
    uniques: { family_signals: [['family_id', 'kind', 'subject_key']] },
    defaults: { family_signals: { status: 'active' } },
  });
  db.seed('budgets', [{ id: 'b1', family_id: 'f1', category: 'Groceries', amount: 2000, period: 'monthly' }]);
  db.seed('transactions', [{ id: 't1', family_id: 'f1', type: 'expense', category: 'Groceries', amount: 2768.5, date: '2026-09-10' }]);
  return db;
};
const detectAs = async (db: InMemorySupabase, code: LocaleCode) => {
  const { locale, t } = readerFor(code);
  expect((await runSignalDetection(db as unknown as DB, 'f1', locale, t, NOW)).ok).toBe(true);
  return db.table('family_signals').find((row) => row.kind === 'budget_drift')!;
};
const SPENT_EN = `Spent ${usd(276850, 'en-US')} of your ${usd(200000, 'en-US')} monthly Groceries budget this period.`;

describe('Family Intelligence words budget drift for its reader', () => {
  it('a German member\'s Refresh stores "2.768,50 $ … 2.000 $", with no English around it', async () => {
    const row = await detectAs(signalsDb(), 'de-DE');
    expectGerman(String(row.detail));
    expect(plain(String(row.detail))).toContain(plain(usd(200000, 'de-DE')));
    expectNoEnglish(String(row.detail), 'Spent', 'of your');
    expectNoEnglish(String(row.title), 'Over budget');
  });

  it('an American one stores the catalogue\'s English sentence', async () => {
    const row = await detectAs(signalsDb(), 'en-US');
    expect(row.title).toBe('Over budget on Groceries');
    expect(row.detail).toBe(SPENT_EN);
  });

  it('a row written by the cron in en-US reads German on the Family Intelligence page', async () => {
    const db = signalsDb();
    expect((await detectAs(db, 'en-US')).detail).toBe(SPENT_EN);
    h.db = db;
    const html = withProvider('de-DE', await FamilySignalsPage());
    expectGerman(html);
    expectNoEnglish(html, 'Spent', 'of your');
  });

  it('and in the reasoning report a German parent reads, where it lands under "matters most"', async () => {
    const db = signalsDb();
    await detectAs(db, 'en-US');
    const { locale, t } = readerFor('de-DE');
    const report = await loadReasoningReport(db as unknown as DB, 'f1', 'UTC', locale, t, NOW);
    const drift = report.answers.flatMap((a) => a.items).find((i) => (i.detail ?? '').includes('2.768'));
    expect(drift, 'the budget-drift item is not in the report in German').toBeDefined();
    expectGerman(String(drift!.detail));
    expectNoEnglish(`${drift!.title} ${drift!.detail}`, 'Spent', 'of your', 'Over budget');
  });

  it("the model's context reads it in English whoever refreshed, so the manager-only filter still sees a budget", async () => {
    // A Spanish parent's Refresh stores the drift in Spanish, and the filter in
    // lib/ai/context/slices/proactive.ts matches ENGLISH words: read as stored,
    // "presupuesto" would reach a child's context. Worded again in en-US from
    // its evidence, it is withheld from a child and read in English by a parent.
    const db = signalsDb();
    await detectAs(db, 'es-ES');
    h.db = db; // the household counts read through the request client
    // Only the fields this slice reads; the rest of a scope and an env belong to
    // other slices.
    const load = (canManage: boolean) => proactiveSlice.load(
      { db, familyId: 'f1' } as unknown as ServiceScope,
      { tz: 'UTC', now: NOW, viewer: { canManage }, members: [], pageContext: null } as unknown as SliceEnv,
    );
    const child = await load(false);
    const parent = await load(true);
    expect(child.ok && parent.ok).toBe(true);
    if (!child.ok || !parent.ok) return;
    const childData = child.data.data as ProactiveSliceData;
    const parentData = parent.data.data as ProactiveSliceData;
    expect(childData.signals.find((s) => s.kind === 'budget_drift')).toBeUndefined();
    expect(parentData.signals.find((s) => s.kind === 'budget_drift')?.detail).toBe(SPENT_EN);
  });
});

// ── Decisions and Group Voting ───────────────────────────────────────────────
describe('the Decision Engine words a budget breach for its reader', () => {
  const trip = [
    { id: 'cruise', label: 'Cruise', costCents: 476850, benefit: 90 },
    { id: 'cabin', label: 'Cabin', costCents: 120000, benefit: 60 },
  ];

  it('on the Decisions page a German parent reads the breach, the budget and each cost in German', () => {
    h.tables = {
      family_decisions: [{ id: 'd1', family_id: 'f1', question: 'Which trip?', budget_cents: 200000, max_travel_minutes: null, weights: {}, status: 'open', decided_option_id: null }],
      decision_options: [
        { id: 'cruise', family_id: 'f1', decision_id: 'd1', label: 'Cruise', cost_cents: 476850, time_minutes: null, travel_minutes: null, load_delta: null, benefit: 90 },
        { id: 'cabin', family_id: 'f1', decision_id: 'd1', label: 'Cabin', cost_cents: 120000, time_minutes: null, travel_minutes: null, load_delta: null, benefit: 60 },
      ],
    };
    const html = withProvider('de-DE', createElement(DecisionsModule));
    expectGerman(html);
    for (const cents of [200000, 476850, 120000]) expect(plain(html)).toContain(plain(usd(cents, 'de-DE')));
    expectNoEnglish(html, 'over budget by', "Doesn't fit:", 'Budget $', '$2000', '$4769', '$1200');

    const american = withProvider('en-US', createElement(DecisionsModule));
    expect(american).toContain(`over budget by ${usd(276850, 'en-US')}`);
    expect(american).toContain(`Budget ${usd(200000, 'en-US')}`);
    expect(american).toContain(usd(476850, 'en-US'));
  });

  it('and so does Group Voting, which carries the same breach into its conflicts', () => {
    const options = trip.map((o) => ({ id: o.id, label: o.label, votes: o.id === 'cruise' ? 3 : 1, costCents: o.costCents }));
    const de = readerFor('de-DE');
    const german = facilitateConsensus(options, { budgetCents: 200000 }, de.locale, de.t);
    const violations = german.ranked.find((r) => r.id === 'cruise')!.violations.join(' ');
    expectGerman(violations);
    expectNoEnglish(violations, 'over budget by');
    const conflicts = german.conflicts.join(' ');
    expectGerman(conflicts);
    expectNoEnglish(conflicts, 'The current favorite', 'Closest workable pick', 'over budget by');

    const en = readerFor('en-US');
    const american = evaluateDecision(trip, { budgetCents: 200000 }, en.locale, en.t);
    expect(american.ranked.find((r) => r.id === 'cruise')!.violations).toEqual([`over budget by ${usd(276850, 'en-US')}`]);
    expect(american.ranked.find((r) => r.id === 'cruise')!.rationale).toBe(`Doesn't fit: over budget by ${usd(276850, 'en-US')}.`);
  });
});

// ── Food Health Score ────────────────────────────────────────────────────────
describe('the Food Health Score words its budget line for its reader', () => {
  // NOT a surface a family reaches today: the kitchen page passes
  // weeklyBudgetCents: null and the kitchen dashboard never renders a sub-score's
  // detail (lib/food/score.ts says so). This pins the pure function for the day
  // a food budget exists, with a budget no production path supplies yet.
  const input: FoodScoreInput = {
    plannedSlots: 7, totalSlots: 7, distinctDishes: 7, perDayNutrition: null,
    pantryTotal: 0, pantryExpired: 0, pantryExpiringSoon: 0, plannedUsingExpiring: 0,
    plannedCostCents: 276850, weeklyBudgetCents: 300000, avgRating: null,
  };
  const budgetLine = (code: LocaleCode) => {
    const { locale, t } = readerFor(code);
    return computeFoodScore(input, locale, t).subScores.find((s) => s.key === 'budget')!.detail;
  };

  it('reads whole amounts in the reader\'s format, inside the reader\'s sentence', () => {
    const german = budgetLine('de-DE');
    expectGerman(german, 276900);
    expect(plain(german)).toContain(plain(usd(300000, 'de-DE')));
    expectNoEnglish(german, ' of ');
    expect(budgetLine('en-US')).toBe(`${usd(276900, 'en-US')} of ${usd(300000, 'en-US')} budget`);
  });
});

// ── Chores ───────────────────────────────────────────────────────────────────
describe("a chore's cash reward reads in the kid's and the parent's own format", () => {
  it('the kid submit page shows the German amount, not "$2768.50", and no "up to"', async () => {
    const db = createInMemorySupabase<DB>();
    db.seed('chore_assignments', [{ id: 'a1', family_id: 'f1', chore_id: 'c1', member_id: 'm1', status: 'todo' }]);
    db.seed('chores', [{
      id: 'c1', family_id: 'f1', title: 'Wash the car', icon: '🚗', reward_mode: 'fixed_cash', cash_cents: 276850,
      points: null, points_min: null, points_max: null, cash_min_cents: null, cash_max_cents: null,
      difficulty: 'medium', proof_required: 'none', est_minutes: null, instructions: null, description: null,
    }]);
    h.db = db;
    const render = async (code: LocaleCode) => {
      h.locale = code;
      return renderToStaticMarkup(await SubmitProofPage({ params: Promise.resolve({ assignmentId: 'a1' }) }));
    };
    const german = await render('de-DE');
    expectGerman(german);
    expectNoEnglish(german, 'up to');
    expect(await render('en-US')).toContain(`up to ${usd(276850, 'en-US')}`);
  });

  it('the parent review card suggests the German amount, not "$2768.50", and no "Suggests:"', () => {
    const item: ReviewItem = {
      submissionId: 's1', choreTitle: 'Wash the car', instructions: null, memberName: 'Mia', memberColor: null, note: null,
      status: 'pending', mediaUrls: [], aiScore: 92, aiStatus: 'scored', aiKidFeedback: 'Great job', aiParentSummary: null,
      aiIsFallback: false, safetyFlags: [], recommendedType: 'cash', recommendedAmount: 2768.5, rewardMode: 'fixed_cash',
      defaultPoints: 0, isDisputed: false, disputeReason: null,
    };
    const german = withProvider('de-DE', createElement(ReviewCard, { item }));
    expectGerman(german);
    expectNoEnglish(german, 'Suggests');
    expect(withProvider('en-US', createElement(ReviewCard, { item }))).toContain(`Suggests: ${usd(276850, 'en-US')}`);
  });

  it('fmtCash itself follows the reader it is handed', () => {
    expect(fmtCash(276850, 'de-DE')).toBe(usd(276850, 'de-DE'));
    expect(plain(fmtCash(276850, 'de-DE'))).toBe('2.768,50 $');
    expect(fmtCash(276850, 'en-US')).toBe(usd(276850, 'en-US'));
  });
});
