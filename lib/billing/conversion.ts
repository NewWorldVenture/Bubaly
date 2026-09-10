// Pure paid-state transition detection for the admin alert.
// Tested without Stripe or Supabase.
import { planLevel } from '@/lib/constants/plans';

type SubState = { plan?: string | null; status?: string | null } | null | undefined;

/** True when a subscription is a paid plan in the active state. */
export function isPaidActive(s: { plan?: string | null; status?: string | null }): boolean {
  return !!s.plan && s.plan !== 'free' && s.status === 'active';
}

/** Includes reactivation from past_due/canceled; unchanged paid renewals do not fire. */
export function isNewPaidConversion(prev: SubState, next: { plan: string; status: string }): boolean {
  if (!isPaidActive(next)) return false;
  if (!prev) return true;
  return !isPaidActive({ plan: prev.plan, status: prev.status });
}

const LOST_STATUSES = new Set(['canceled', 'unpaid', 'incomplete_expired']);

/** A paid family leaves paid-active for a terminal loss or free plan. */
export function isChurn(prev: SubState, next: { plan: string; status: string }): boolean {
  if (!prev || !isPaidActive({ plan: prev.plan, status: prev.status })) return false;
  if (isPaidActive(next)) return false;
  return next.plan === 'free' || LOST_STATUSES.has(next.status);
}

// X10 uses best-effort subscription notifications as recorded paid activations.
// They include reactivations, and their dates are notification recording times.
// Neither first-ever payment nor causation can be established from these rows.
export type ActivationReach = { familyId: string; reachedAt: string };
export type ConversionSubscription = { familyId: string; plan: string | null; status: string | null };
export type PaidActivationReceipt = {
  familyId: string | null;
  recordedAt: string;
  kind: string;
  relatedType: string | null;
  meta: unknown;
};
export type ConversionAfterValue = {
  /** Distinct families with a first-value milestone: the denominator. */
  families: number;
  /** Currently paid-active families with a qualifying record at/after first value. */
  recordedPaidActivations: number;
  rate: number | null;
  /** First value to the first qualifying notification recorded at/after it. */
  medianDays: number | null;
  /** Currently paid-active families with qualifying records only before first value. */
  priorOnly: number;
  /** Currently paid-active families with no valid dated qualifying record. */
  missingEvidence: number;
  /** First-value families whose current rows disagree about paid-active status. */
  ambiguousStatus: number;
};

const DAY_MS = 86_400_000;
function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(median * 10) / 10;
}

/** Count each family once using its earliest first-value milestone. */
export function conversionAfterValue(
  activations: ActivationReach[],
  subs: ConversionSubscription[],
  receipts: PaidActivationReceipt[],
  asOf: Date = new Date(),
): ConversionAfterValue {
  const until = asOf.getTime();
  const firstValueAt = new Map<string, number>();
  for (const a of activations) {
    const at = Date.parse(a.reachedAt);
    if (!a.familyId || !Number.isFinite(at) || at > until) continue;
    const prev = firstValueAt.get(a.familyId);
    if (prev === undefined || at < prev) firstValueAt.set(a.familyId, at);
  }
  // family_id is indexed but not unique in the existing subscriptions schema.
  // Consistent rows agree about the cohort; conflicting rows prove no current
  // paid status. Their updated_at values cannot select an authoritative row.
  const currentStatus = new Map<string, boolean | null>();
  for (const sub of subs) {
    const paid = planLevel(sub.plan) > 0 && sub.status === 'active';
    const previous = currentStatus.get(sub.familyId);
    currentStatus.set(sub.familyId, previous === undefined ? paid : previous === paid ? paid : null);
  }
  const paidFamilies = new Set([...currentStatus].filter(([, paid]) => paid === true).map(([familyId]) => familyId));
  const datedFamilies = new Set<string>();
  const firstAfterValue = new Map<string, number>();
  for (const receipt of receipts) {
    if (receipt.kind !== 'subscription' || receipt.relatedType !== 'subscription' || !receipt.familyId) continue;
    if (!receipt.meta || typeof receipt.meta !== 'object' || Array.isArray(receipt.meta)) continue;
    const meta = receipt.meta as Record<string, unknown>;
    if (typeof meta.plan !== 'string' || planLevel(meta.plan) === 0 || meta.status !== 'active') continue;
    const at = Date.parse(receipt.recordedAt);
    if (!Number.isFinite(at) || at > until) continue;
    const reached = firstValueAt.get(receipt.familyId);
    if (reached === undefined || !paidFamilies.has(receipt.familyId)) continue;
    datedFamilies.add(receipt.familyId);
    if (at < reached) continue;
    const prev = firstAfterValue.get(receipt.familyId);
    if (prev === undefined || at < prev) firstAfterValue.set(receipt.familyId, at);
  }

  const days: number[] = [];
  let priorOnly = 0;
  let missingEvidence = 0;
  for (const [familyId, reached] of firstValueAt) {
    if (!paidFamilies.has(familyId)) continue;
    const recorded = firstAfterValue.get(familyId);
    if (recorded !== undefined) days.push((recorded - reached) / DAY_MS);
    else if (datedFamilies.has(familyId)) priorOnly++;
    else missingEvidence++;
  }
  const families = firstValueAt.size;
  return {
    families,
    recordedPaidActivations: days.length,
    rate: families > 0 ? days.length / families : null,
    medianDays: medianOf(days),
    priorOnly,
    missingEvidence,
    ambiguousStatus: [...firstValueAt.keys()].filter((familyId) => currentStatus.get(familyId) === null).length,
  };
}
