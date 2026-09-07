// lib/finance/cfo-prompts.ts — the requests the Family CFO page files with
// the concierge. Kept as named constants (not inline JSX strings) so a test
// can prove each one is recognised as the intent it is meant to trigger:
// "Explain this month" must land on the spending_review workflow, the same
// path the Home Ask bar takes to POST /api/ai/requests.

/** Files the spending_review workflow for the current month. */
export const EXPLAIN_MONTH_REQUEST =
  'Spending review for this month: where did our money go, and what is over budget?';
