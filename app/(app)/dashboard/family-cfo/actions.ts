'use server';

// Family CFO server actions. "Can we afford it?" re-reads the SAME forecast
// input the page built (bills, goals, balances, plan-linked commitments) and
// tries the proposed commitment against it with the pure assessAffordability()
// — nothing is written. A read failure is reported as a failure, never as a
// verdict: an affordability answer built on missing bills would be a
// confident "yes" a family could act on.
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
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
  | { ok: false; error: string };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function assessAffordabilityAction(input: AffordabilityFormInput): Promise<AffordabilityActionResult> {
  const t = await getTranslations();
  const ctx = await requireUserContext();

  const amount = Number(input.amountDollars);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: t('familyCfoActions.enterAnAmountAboveZero') };
  if (typeof input.date !== 'string' || !DATE_RE.test(input.date) || Number.isNaN(Date.parse(`${input.date}T00:00:00Z`))) {
    return { ok: false, error: t('familyCfoActions.pickTheDateItWouldLand') };
  }
  const recurrence: ScenarioRecurrence = (SCENARIO_RECURRENCES as readonly string[]).includes(input.recurrence)
    ? input.recurrence
    : 'once';
  const label = (typeof input.label === 'string' ? input.label : '').trim().slice(0, 120) || t('familyCfoActions.thisExpense');

  const supabase = await createServer();
  try {
    const base = await loadMoneyTimelineInput(supabase, ctx.active.familyId);
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
