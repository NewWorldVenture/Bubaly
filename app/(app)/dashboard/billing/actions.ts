// The write path for the money tables.
//
// Budgets, savings goals and transactions were written straight from the browser
// across four components, every update and delete filtering `id` alone. On money
// that is worth naming precisely: tenancy rested entirely on RLS, and the
// household's own record of who deleted a transaction had nothing in it.
//
// The sharpest fix is not the tenancy one. `savings-view` computed a goal's new
// balance in the browser and wrote the ABSOLUTE back, so two parents each adding
// £20 to a goal holding £100 both wrote £120 — the family put in £40 and the goal
// gained £20. `contributeToSavingsGoal` takes the delta and applies it under a
// compare-and-set. See `tests/savings-contribution-race.test.ts`.
//
// One file for three routes because it is one domain: /dashboard/billing shows
// transactions, /dashboard/budgets the budgets, /dashboard/savings the goals, and
// billing-module shows all three. Each write revalidates every surface that
// renders what it changed, rather than leaving one of them stale.
'use server';

import { revalidatePath } from 'next/cache';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import {
  contributeToSavingsGoal, createSavingsGoal, createTransaction,
  deleteBudget, deleteSavingsGoal, deleteTransaction, updateBudget,
  type CreateSavingsGoalInput, type CreateTransactionInput,
} from '@/lib/services/finances';
import type { BudgetPeriod } from '@/lib/database.types';
import { scopeFromUserContext } from '@/lib/services/scope';
import { describeActionError } from '@/lib/supabase/errors';

const BILLING = '/dashboard/billing';
const BUDGETS = '/dashboard/budgets';
const SAVINGS = '/dashboard/savings';

export type MoneyActionResult = { ok: true; id: string } | { ok: false; error: string };

/** Session + scope, resolved OUTSIDE the try: `requireUserContext` redirects by throwing. */
async function moneyScope() {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  return scopeFromUserContext(ctx, supabase);
}

export async function contributeToGoalAction(goalId: string, delta: number): Promise<MoneyActionResult> {
  if (!goalId) return { ok: false, error: 'That savings goal could not be found.' };
  const scope = await moneyScope();

  try {
    const result = await contributeToSavingsGoal(scope, goalId, delta);
    if (!result.ok) return { ok: false, error: result.error };

    revalidatePath(SAVINGS);
    revalidatePath(BILLING);
    return { ok: true, id: result.data.id };
  } catch (err) {
    console.error('[money-action] contribute failed', err);
    return { ok: false, error: describeActionError(err, 'Could not update that savings goal.') };
  }
}

export async function deleteSavingsGoalAction(goalId: string): Promise<MoneyActionResult> {
  if (!goalId) return { ok: false, error: 'That savings goal could not be found.' };
  const scope = await moneyScope();

  try {
    const result = await deleteSavingsGoal(scope, goalId);
    if (!result.ok) return { ok: false, error: result.error };

    revalidatePath(SAVINGS);
    revalidatePath(BILLING);
    return { ok: true, id: result.data.id };
  } catch (err) {
    console.error('[money-action] savings goal delete failed', err);
    return { ok: false, error: describeActionError(err, 'Could not remove that savings goal.') };
  }
}

export async function deleteBudgetAction(budgetId: string): Promise<MoneyActionResult> {
  if (!budgetId) return { ok: false, error: 'That budget could not be found.' };
  const scope = await moneyScope();

  try {
    const result = await deleteBudget(scope, budgetId);
    if (!result.ok) return { ok: false, error: result.error };

    revalidatePath(BUDGETS);
    revalidatePath(BILLING);
    return { ok: true, id: result.data.id };
  } catch (err) {
    console.error('[money-action] budget delete failed', err);
    return { ok: false, error: describeActionError(err, 'Could not remove that budget.') };
  }
}

export async function deleteTransactionAction(transactionId: string): Promise<MoneyActionResult> {
  if (!transactionId) return { ok: false, error: 'That transaction could not be found.' };
  const scope = await moneyScope();

  try {
    const result = await deleteTransaction(scope, transactionId);
    if (!result.ok) return { ok: false, error: result.error };

    revalidatePath(BILLING);
    revalidatePath(BUDGETS);
    return { ok: true, id: result.data.id };
  } catch (err) {
    console.error('[money-action] transaction delete failed', err);
    return { ok: false, error: describeActionError(err, 'Could not remove that transaction.') };
  }
}

export async function createTransactionAction(input: CreateTransactionInput): Promise<MoneyActionResult> {
  const scope = await moneyScope();

  try {
    // `createTransaction` verifies the account and the member belong to THIS
    // family before writing either id — the raw inserts wrote whatever the form
    // held, so a stale account id from another household would have gone in.
    const result = await createTransaction(scope, input);
    if (!result.ok) return { ok: false, error: result.error };

    revalidatePath(BILLING);
    revalidatePath(BUDGETS);
    return { ok: true, id: result.data.id };
  } catch (err) {
    console.error('[money-action] transaction create failed', err);
    return { ok: false, error: describeActionError(err, 'Could not add that transaction.') };
  }
}

/**
 * Set a category's budget.
 *
 * A BEHAVIOUR CHANGE, made deliberately: the forms inserted a row every time, so
 * adding a Groceries budget twice left the family with two, each reporting the
 * other's spend as unbudgeted. `updateBudget` matches the category
 * case-insensitively and updates the existing row — "groceries" and "Groceries"
 * are one budget, and adding one twice sets it rather than duplicating it.
 */
export async function setBudgetAction(
  category: string, amount: number, period?: BudgetPeriod | null,
): Promise<MoneyActionResult> {
  const scope = await moneyScope();

  try {
    const result = await updateBudget(scope, { category, amount, period: period ?? null });
    if (!result.ok) return { ok: false, error: result.error };

    revalidatePath(BUDGETS);
    revalidatePath(BILLING);
    return { ok: true, id: result.data.budget.id };
  } catch (err) {
    console.error('[money-action] budget save failed', err);
    return { ok: false, error: describeActionError(err, 'Could not save that budget.') };
  }
}

export async function createSavingsGoalAction(input: CreateSavingsGoalInput): Promise<MoneyActionResult> {
  const scope = await moneyScope();

  try {
    const result = await createSavingsGoal(scope, input);
    if (!result.ok) return { ok: false, error: result.error };

    revalidatePath(SAVINGS);
    revalidatePath(BILLING);
    return { ok: true, id: result.data.id };
  } catch (err) {
    console.error('[money-action] savings goal create failed', err);
    return { ok: false, error: describeActionError(err, 'Could not create that savings goal.') };
  }
}
