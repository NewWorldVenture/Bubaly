// lib/approvals/threshold.ts — how many yeses a request needs, and from whom.
//
// `approval_requests.approval_model` was stored, offered in the Trust UI and
// read by nothing: a policy saved as "Two-parent" approved on one vote, from
// anyone the family calls a manager. The count lived in a second, independent
// field, so the two could disagree and the label was the one that lost.
//
// This is the single place that turns a model into a rule. It is pure so the
// rule can be tested without a database, and so the same answer is used to
// decide a vote and to tell the family what the card is waiting for.

/** The models a family can choose. Older rows may carry retired spellings. */
export const APPROVAL_MODELS = ['single', 'two_parent', 'consensus'] as const;
export type ApprovalModel = (typeof APPROVAL_MODELS)[number];

export type Threshold = {
  /** How many approvals must be recorded before the action runs. */
  required: number;
  /** Whether only members with the `parent` role may cast a counting approval. */
  parentsOnly: boolean;
};

/**
 * `managerCount` is how many active parents/adults could vote — only consensus
 * needs it, and it is clamped to at least one so a single-manager family is not
 * left with an unreachable threshold.
 *
 * `stored` (a row's own `required_approvals`) may raise a model's floor but
 * never lower it: a family that asked for two parents does not get one because
 * a form defaulted the number to 1.
 */
export function thresholdFor(
  model: string | null | undefined,
  stored: number | null | undefined,
  managerCount: number,
): Threshold {
  const floor = Math.max(1, Math.trunc(stored ?? 1) || 1);
  const managers = Math.max(1, managerCount);
  switch (model) {
    case 'two_parent':
      return { required: Math.max(2, floor), parentsOnly: true };
    case 'consensus':
      return { required: Math.max(managers, floor), parentsOnly: false };
    // 'single', 'first_available' and 'sequential' all mean "count the yeses":
    // the first two are the same rule, and nothing in the product has ever
    // ordered approvers. They are accepted here so rows written before the
    // vocabulary shrank keep working, and are no longer offered as choices.
    default:
      return { required: floor, parentsOnly: false };
  }
}

/** What the card says it is waiting for. */
export function describeThreshold(t: Threshold, recorded: number): string {
  if (t.required <= 1) return '';
  const who = t.parentsOnly ? 'parent' : 'approval';
  const plural = t.parentsOnly ? 'parents' : 'approvals';
  return `Needs ${t.required} ${t.required === 1 ? who : plural} — ${recorded} recorded`;
}
