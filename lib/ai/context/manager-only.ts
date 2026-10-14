// Words that put an item in an area only the adults who manage the family read.
//
// The suggestion queues are household-wide and can mention budgets, bills or
// documents. Those areas are manager-only (§4, `SLICE_ACCESS`), so for anyone
// else an item that touches them is dropped — the same rule the money and
// documents slices enforce by not loading. The proactive AI slice applies it
// to the cards, signals and recommendations it hands the model. The reasoning
// report and the operating index (lib/operating-index/audience.ts) apply the
// words only to the items an Autopilot card or an approval worded: the rest
// are worded from the calendar and the family's names, and "Bill" is a name as
// often as a bill.
//
// Each word is matched with its plural ("2 documents expiring soon", "3
// accounts", "Renew both passports"), and the financ- stem with any ending
// ("financial", "finances").
//
// The rule is ENGLISH: whatever it is asked about must be worded in en-US
// first (see MODEL_LOCALE in ./slices/proactive.ts).

export const MANAGER_ONLY_RE = /\b(budgets?|bills?|spend(?:s|ing)?|money|financ\w*|transactions?|accounts?|salary|salaries|incomes?|documents?|passports?|insurances?|tax(?:es)?|vaults?|subscriptions?)\b/i;

/** True when any of `parts` touches a manager-only area. */
export function managerOnlyText(...parts: (string | null | undefined)[]): boolean {
  return MANAGER_ONLY_RE.test(parts.filter(Boolean).join(' '));
}
