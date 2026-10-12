// lib/trust/amount.ts — the money an AI action carries, for a household
// policy's `conditions.maxAmountCents`.
//
// Pure and import-free on purpose, so every gate that evaluates a policy can
// read the amount the same way: the tool executor's gate
// (lib/ai/tools/execute.ts), the gate for chat, Magic Import and the school
// desk (lib/trust/ai-gate.ts), the planner's dry run
// (lib/ai/planner/validate.ts) and the rule a held step's approval is filed
// under (lib/ai/runs/executor.ts). It used to live in the run executor, which
// imports the tool executor, so the tool executor could not import it back —
// and the two gates that never read an amount handed the engine none, which
// it reads as 0 (`conditionsSatisfied`). "Bubaly may spend up to $50" then
// cleared a $900 `finances.updateBudget` with nobody asked.

const CENT_KEYS = ['amount_cents', 'amountCents'] as const;
const DOLLAR_KEYS = ['amount', 'budget', 'target_amount', 'cost'] as const;

/**
 * A money amount in a tool's arguments, in cents; null when the tool carries
 * none. `amount_cents`/`amountCents` are cents already; the registry's
 * `amount`, `budget`, `target_amount` and `cost` are dollars.
 */
export function readAmountCents(input: unknown): number | null {
  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  for (const key of CENT_KEYS) {
    if (typeof record[key] === 'number' && Number.isFinite(record[key])) return Math.round(record[key] as number);
  }
  for (const key of DOLLAR_KEYS) {
    if (typeof record[key] === 'number' && Number.isFinite(record[key])) return Math.round((record[key] as number) * 100);
  }
  return null;
}

/** Whether the arguments name a money field at all, whatever its value. */
export function carriesAmount(input: unknown): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const record = input as Record<string, unknown>;
  return [...CENT_KEYS, ...DOLLAR_KEYS].some((key) => record[key] !== undefined && record[key] !== null);
}

/**
 * The amount to evaluate when an action's money could not be read — a value
 * bound from an earlier step that did not resolve, or arguments the tool's own
 * schema refuses. It is not "no money": the engine reads a missing amount as 0
 * (`conditionsSatisfied`), and a policy capped by `maxAmountCents` would then
 * match whatever the action finally moves. Unbounded, so no capped rule does.
 * Only ever a context value for the engine; never stored.
 */
export const UNKNOWN_AMOUNT_CENTS = Number.POSITIVE_INFINITY;
