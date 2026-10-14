// Words that put an item in an area only the adults who manage the family read.
//
// The reasoning report and the suggestion queues are household-wide and can
// mention budgets, bills or documents. Those areas are manager-only (§4,
// `SLICE_ACCESS`), so for anyone else an item that touches them is dropped —
// the same rule the money and documents slices enforce by not loading. The
// proactive AI slice applies it to what it hands the model, and the reasoning
// report (lib/reasoning/engine-server.ts) to what it shows a person.
//
// The rule is ENGLISH: whatever it is asked about must be worded in en-US
// first (see MODEL_LOCALE in ./slices/proactive.ts).
import { isHouseholdMoneyRoute } from '@/lib/finance/household-money';

export const MANAGER_ONLY_RE = /\b(budget|bill|bills|spend|spending|money|financ|transaction|account|salary|income|document|passport|insurance|tax|vault|subscription)\b/i;

/** True when any of `parts` touches a manager-only area. */
export function managerOnlyText(...parts: (string | null | undefined)[]): boolean {
  return MANAGER_ONLY_RE.test(parts.filter(Boolean).join(' '));
}

/**
 * True for a linked item that is about a manager-only area: its words touch
 * one, or it links to one of the household's money pages, whatever its words
 * say. "2 accounts are below zero" names no word above ("accounts" is not
 * "account"), and it links to the wallet.
 */
export function managerOnlyItem(title: string, detail: string | null | undefined, href: string | null | undefined): boolean {
  return isHouseholdMoneyRoute(href) || managerOnlyText(title, detail, href);
}
