import { describe, expect, it } from 'vitest';
import { expectSays, expectTranslates } from './helpers/translated';
import fs from 'node:fs';
import { classifyIntentFast } from '@/lib/ai/context/intents';
import { EXPLAIN_MONTH_REQUEST } from '@/lib/finance/cfo-prompts';

const page = fs.readFileSync('app/(app)/dashboard/family-cfo/page.tsx', 'utf8');

// PLA-0776: Family CFO is a money surface that advertises "every figure is
// live". If any of its five financial reads (accounts, bills, savings goals,
// transactions, budgets) fails, it must fail closed — never render Net position
// $0 / "Due in 30 days $0" / no goals, a reassuring-but-wrong financial picture
// a family could act on (miss a bill, assume savings vanished). A genuinely
// missing table (unapplied migration) is still tolerated as empty.
describe('family-cfo page read boundary', () => {
  it('collects the five finance read errors with a missing-table filter', () => {
    expect(page).toContain('const financeError = [accountsRes.error, billsRes.error, goalsRes.error, spendRes.error, budgetsRes.error]');
    expect(page).toContain('.find((e) => e && !isMissingTableError(e));');
  });

  it('logs and returns an ErrorState on a finance read failure', () => {
    expect(page).toContain('if (financeError) {');
    expect(page).toContain("console.error('[dashboard/family-cfo] finance read failed', financeError);");
    expect(page).toContain("return <ErrorState message={");
    expectSays(page, 'familyCfo.couldNotLoadYourFamily', "Could not load your family finances from Supabase. Refresh and try again.");
  });

  it('derives the finance data only after the fail-closed guard', () => {
    const guardIdx = page.indexOf('if (financeError) {');
    const deriveIdx = page.indexOf('const accounts = accountsRes.data;');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(deriveIdx).toBeGreaterThan(guardIdx);
  });
});

// M11 Family CFO: the page carries the 12-week forecast (plan-linked
// commitments + coverage), the "Can we afford it?" form, and links out to the
// money timeline and the digital twin's spend simulator. The forecast is the
// same money as the tiles above it, so it fails closed the same way.
describe('family-cfo forecast surface', () => {
  const actions = fs.readFileSync('app/(app)/dashboard/family-cfo/actions.ts', 'utf8');
  const moneyTimelinePage = fs.readFileSync('app/(app)/dashboard/money-timeline/page.tsx', 'utf8');

  it('fails closed when the forecast loader throws, after the finance guard and before deriving data', () => {
    expect(page).toContain('forecastInput = await loadMoneyTimelineInput(supabase, familyId);');
    expect(page).toContain("console.error('[dashboard/family-cfo] forecast read failed', err);");
    const financeGuard = page.indexOf('if (financeError) {');
    const forecastGuard = page.indexOf("console.error('[dashboard/family-cfo] forecast read failed', err);");
    const deriveIdx = page.indexOf('const accounts = accountsRes.data;');
    expect(financeGuard).toBeLessThan(forecastGuard);
    expect(forecastGuard).toBeLessThan(deriveIdx);
    // The catch renders the same retryable error state, never an empty forecast.
    const catchBlock = page.slice(forecastGuard, deriveIdx);
    expect(catchBlock).toContain("return <ErrorState message={tr('familyCfo.couldNotLoadYourFamily')} />;");
  });

  it('links to the money timeline and the digital twin spend simulator', () => {
    expect(page).toContain('href="/dashboard/money-timeline"');
    expect(page).toContain('href="/dashboard/family-digital-twin"');
    expectSays(page, 'familyCfo.openTheMoneyTimeline', 'Open the money timeline');
    expectSays(page, 'familyCfo.simulateASpendInThe', 'Simulate a spend in the digital twin');
  });

  it('renders the affordability form and files "Explain this month" through the concierge request path', () => {
    expect(page).toContain('<AffordabilityScenario buffer={buffer} />');
    expect(page).toContain('<HandleItButton');
    expect(page).toContain('request={EXPLAIN_MONTH_REQUEST}');
    expectSays(page, 'familyCfo.explainThisMonth', 'Explain this month');
  });

  it('shows autopay bills as covered in the forecast copy', () => {
    expect(page).toContain('{b.autopay && (');
    expectSays(page, 'familyCfo.coveredAutopay', 'Covered · autopay');
    expectSays(page, 'familyCfo.nBillsAreCoveredAutopay', '{covered} bills are covered (autopay or already paid). {open} still need a hand — {amount} in total.');
  });

  it('never answers affordability from a failed read: the action reports the failure instead of a verdict', () => {
    expect(actions).toContain("console.error('[dashboard/family-cfo] affordability read failed', err);");
    expectTranslates(actions, 'familyCfoActions.couldNotReadYourForecast', 'Could not read your forecast from Supabase. Refresh and try again.');
    // The catch hands back a failure the form shows, not an `ok` result.
    expect(actions).toContain("return { ok: false, error: t('familyCfoActions.couldNotReadYourForecast') };");
  });

  it('the money-timeline page fails closed on the same loader', () => {
    expect(moneyTimelinePage).toContain("console.error('[dashboard/money-timeline] forecast read failed', err);");
    expectSays(moneyTimelinePage, 'moneyTimeline.couldNotLoadYourMoney', 'Could not load your money timeline from Supabase. Refresh and try again.');
  });
});

describe('EXPLAIN_MONTH_REQUEST', () => {
  it('is recognised as the spending_review workflow by the deterministic classifier', () => {
    expect(classifyIntentFast(EXPLAIN_MONTH_REQUEST)?.intent).toBe('spending_review');
  });
});


// Every outbound link on the CFO surface must land on a route that exists.
// A plan-linked commitment badge pointing at /dashboard/moves or
// /dashboard/home-projects (neither route exists — they are /dashboard/moving
// and /dashboard/projects) is an inert control dressed as a working one.
describe('family-cfo outbound links resolve to real routes', () => {
  const scenario = fs.readFileSync('components/finance/affordability-scenario.tsx', 'utf8');
  const routes = (source: string) =>
    [...source.matchAll(/(?:href|viewAllHref)\s*[=:]\s*["'](\/dashboard\/[a-z0-9-]+)["']/g)].map((m) => m[1]);

  it('the page and the affordability form only link to dashboard routes with a page.tsx', () => {
    const hrefs = [...new Set([...routes(page), ...routes(scenario)])];
    // billing, money-timeline, family-digital-twin + the four plan-source modules.
    expect(hrefs).toEqual(expect.arrayContaining([
      '/dashboard/money-timeline', '/dashboard/family-digital-twin',
      '/dashboard/subscriptions', '/dashboard/vacations', '/dashboard/moving', '/dashboard/projects',
    ]));
    const missing = hrefs.filter((h) => !fs.existsSync(`app/(app)${h}/page.tsx`));
    expect(missing).toEqual([]);
  });

  it('each plan source badge points at the module that owns the plan', () => {
    expect(page).toContain("subscription: { labelKey: 'familyCfo.subscription', icon: Repeat, href: '/dashboard/subscriptions' }");
    expect(page).toContain("vacation: { labelKey: 'familyCfo.trip', icon: Plane, href: '/dashboard/vacations' }");
    expect(page).toContain("move: { labelKey: 'familyCfo.move', icon: Truck, href: '/dashboard/moving' }");
    expect(page).toContain("project: { labelKey: 'familyCfo.homeProject', icon: Hammer, href: '/dashboard/projects' }");
  });
});

// A counter next to the word "bills" has to count BILLS. The forecast expands a
// monthly bill into three payments inside a 12-week horizon, so reading the
// occurrence counters here told a household with three bills that it had five,
// and a household with one autopay rent that three bills were covered.
describe('family-cfo coverage copy counts bills, not payments', () => {
  const timelineModule = fs.readFileSync('components/modules/money-timeline-module.tsx', 'utf8');

  it('the covered tile and the coverage sentence read the distinct-bill counters', () => {
    expect(page).toContain("tr('familyCfo.nOfMBills', { n: coveredBills, m: coverage.totalBills })");
    expect(page).toContain('const coveredBills = coverage.coveredBills + coverage.paidBills;');
    expect(page).toContain("tr('familyCfo.everyBillInTheNext12', { n: coverage.totalBills })");
    expect(page).toContain('open: coverage.openBills');
    // No "bills" string on this page may be built from an occurrence counter.
    expect(page).not.toContain('coverage.coveredCount');
    expect(page).not.toContain('coverage.paidCount');
    expect(page).not.toContain('coverage.openCount');
  });

  it('the all-clear fires on open BILLS, so a paid recurring bill cannot trigger it', () => {
    expect(page).toContain('coverage.openBills === 0');
    expectSays(page, 'familyCfo.everyBillInTheNext12', 'Every one of the {n} bills in the next 12 weeks is covered — autopay or already paid. Nothing to do by hand.');
  });

  it('the money-timeline module counts autopay bills, not autopay payments', () => {
    expect(timelineModule).toContain("t('moneyTimelineModule.nBillsCoveredByAutopay', { n: timeline.coverage.coveredBills })");
    expect(timelineModule).not.toContain('coverage.coveredCount');
    expectSays(timelineModule, 'moneyTimelineModule.nBillsCoveredByAutopay', '{n} covered by autopay');
  });
});

// A commitment that lands outside the 12-week horizon was never weighed by the
// forecast. Answering it with the green "Yes" chip is an affirmative money
// verdict with no evidence behind it, so it gets a neutral verdict of its own.
describe('affordability answers only what the forecast weighed', () => {
  const scenario = fs.readFileSync('components/finance/affordability-scenario.tsx', 'utf8');

  it('maps the beyond-horizon case to its own neutral chip, never verdictOk', () => {
    expect(scenario).toContain("not_assessed: { labelKey: 'affordabilityScenario.verdictNotAssessed'");
    expectSays(scenario, 'affordabilityScenario.verdictNotAssessed', 'Not in this horizon');
    expect(scenario).toContain("result.verdict === 'not_assessed'");
    // The chip is picked from the verdict alone, so 'ok' can only come from a
    // scenario the forecast actually carried.
    expect(scenario).toContain('const v = result ? VERDICT[result.verdict] : null;');
  });

  it('says the forecast did not reach that date rather than implying a check happened', () => {
    expectSays(scenario, 'affordabilityScenario.nothingInTheNext12Weeks', 'That date is beyond the 12-week forecast, so this has not been checked against it.');
  });
});
