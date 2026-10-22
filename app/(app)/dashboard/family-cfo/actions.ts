'use server';

// Family CFO server actions. "Can we afford it?" re-reads the SAME forecast
// input the page built (bills, goals, balances, plan-linked commitments) and
// tries the proposed commitment against it with the pure assessAffordability()
// — nothing is written. A read failure is reported as a failure, never as a
// verdict: an affordability answer built on missing bills would be a
// confident "yes" a family could act on.
//
// The page in front of this applies four gates (requireFeature's guest and
// plan checks, readsHouseholdMoney, requireAal2), and this action is a second
// door to the same figures: its id ships in the form's client bundle, so a
// child, a guest, a Free family or a password-only session could POST it and
// read back the household's projected lowest balance. It applies the same
// gates, answering with the failure union as billing/actions.ts moneyScope()
// does, because the form awaits the result and a thrown redirect would be lost.
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { aal2Verdict } from '@/lib/auth/require-aal2';
import { readsHouseholdMoney } from '@/lib/finance/household-money';
import { resolveFeatureEntitlement } from '@/lib/server/feature-entitlement';
import { loadMoneyTimelineInput } from '@/lib/finance/timeline-load';
import {
  assessAffordability, SCENARIO_RECURRENCES,
  type AffordabilityResult, type ScenarioRecurrence,
} from '@/lib/finance/timeline';

export type AffordabilityFormInput = {
  label: string;
  amountDollars: number;
  /** YYYY-MM-DD — when the first (or only) payment lands. */
  date: string;
  recurrence: ScenarioRecurrence;
};

export type AffordabilityActionResult =
  | { ok: true; result: AffordabilityResult }
  /** `stepUp` is the /auth/step-up path when the refusal was an assurance one. */
  | { ok: false; error: string; stepUp?: string };

const PAGE = '/dashboard/family-cfo';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function assessAffordabilityAction(input: AffordabilityFormInput): Promise<AffordabilityActionResult> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  // The household's accounts and balances are a parent's or adult's (the held
  // 0514); a guest is neither, so this refuses a guest too.
  if (!readsHouseholdMoney(ctx.active.role)) return { ok: false, error: t('householdMoney.keptByParents') };

  const supabase = await createServer();
  // The same resolver requireFeature uses, so the page and its action cannot
  // disagree about the plan. An unreadable plan is not an answer either way.
  try {
    const entitlement = await resolveFeatureEntitlement(supabase, ctx.active.familyId, PAGE);
    if (!entitlement.allowed) return { ok: false, error: t('familyCfoActions.needsFamilyPlus') };
  } catch (err) {
    console.error('[dashboard/family-cfo] affordability plan read failed', err);
    return { ok: false, error: t('familyCfoActions.couldNotReadYourForecast') };
  }
  const verdict = await aal2Verdict(ctx, 'money', PAGE);
  if (verdict.action === 'step_up') return { ok: false, error: t('familyCfoActions.needsYourCode'), stepUp: verdict.to };

  const amount = Number(input.amountDollars);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: t('familyCfoActions.enterAnAmountAboveZero') };
  if (typeof input.date !== 'string' || !DATE_RE.test(input.date) || Number.isNaN(Date.parse(`${input.date}T00:00:00Z`))) {
    return { ok: false, error: t('familyCfoActions.pickTheDateItWouldLand') };
  }
  const recurrence: ScenarioRecurrence = (SCENARIO_RECURRENCES as readonly string[]).includes(input.recurrence)
    ? input.recurrence
    : 'once';
  const label = (typeof input.label === 'string' ? input.label : '').trim().slice(0, 120) || t('familyCfoActions.thisExpense');

  try {
    // The forecast's day keys are the family's, not the server's: this action
    // runs wherever Vercel puts it, and "today" has to mean the household's.
    const base = await loadMoneyTimelineInput(supabase, ctx.active.familyId, ctx.active.family.timezone || 'UTC');
    const result = assessAffordability(base, {
      label,
      amount: Math.round(amount * 100) / 100,
      date: input.date,
      recurrence: recurrence === 'once' ? null : recurrence,
    });
    return { ok: true, result };
  } catch (err) {
    console.error('[dashboard/family-cfo] affordability read failed', err);
    return { ok: false, error: t('familyCfoActions.couldNotReadYourForecast') };
  }
}
