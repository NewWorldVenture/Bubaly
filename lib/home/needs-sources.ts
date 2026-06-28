// lib/home/needs-sources.ts — pure mappers that turn each domain's pending rows
// into Home "Needs you" items (see ./needs-attention.ts for ranking). DOM-free +
// unit-testable. The non-trivial domains (money approvals, renewals) live here;
// the simple count-based signals (reminders, chores) are built inline by the reader.

import type { NeedItem, NeedUrgency } from './needs-attention';

/** Compact USD from integer cents: $12 or $12.50. */
export function usdFromCents(cents: number): string {
  const v = cents / 100;
  return Number.isInteger(v) ? `$${v}` : `$${v.toFixed(2)}`;
}

const APPROVAL_META: Record<string, { label: string; href: string }> = {
  card_spend: { label: 'Card purchase', href: '/wallet/cards' },
  withdrawal: { label: 'Withdrawal', href: '/wallet' },
  gift: { label: 'Gift', href: '/wallet' },
  chore_reward: { label: 'Chore reward', href: '/wallet' },
  allowance_request: { label: 'Allowance request', href: '/wallet' },
};

export type ParentApprovalRow = { id: string; kind: string; amount_cents: number | null; created_at: string };

/** A pending money approval → an urgent "needs you" decision card. */
export function parentApprovalToNeed(r: ParentApprovalRow): NeedItem {
  const meta = APPROVAL_META[r.kind] ?? { label: 'Approval', href: '/wallet' };
  const amount = r.amount_cents != null && r.amount_cents > 0 ? ` · ${usdFromCents(r.amount_cents)}` : '';
  return {
    id: `approval:${r.id}`,
    kind: 'approval',
    title: `${meta.label} to approve${amount}`,
    href: meta.href,
    urgency: 'urgent',
    createdAt: r.created_at,
  };
}

export type RenewalRow = { id: string; title: string; expires_at: string; reminder_days: number | null; status: string; created_at?: string };

/**
 * A renewal → a "needs you" item, but only once it's inside its reminder window
 * (or already expired). Returns null when it's not yet due, already renewed, or
 * cancelled. Urgency escalates to 'urgent' within 3 days / past due.
 */
export function renewalToNeed(r: RenewalRow, now: Date): NeedItem | null {
  if (r.status === 'renewed' || r.status === 'cancelled') return null;
  const expires = Date.parse(r.expires_at);
  if (!Number.isFinite(expires)) return null;
  const days = Math.floor((expires - now.getTime()) / 86_400_000);
  const window = r.reminder_days ?? 14;
  if (days > window) return null; // not in the reminder window yet
  const when = days < 0 ? 'expired' : days === 0 ? 'due today' : `due in ${days}d`;
  const urgency: NeedUrgency = days <= 3 ? 'urgent' : 'normal';
  return {
    id: `renewal:${r.id}`,
    kind: 'renewal',
    title: `Renew ${r.title} — ${when}`,
    href: '/dashboard/renewals',
    urgency,
    createdAt: r.created_at ?? r.expires_at,
  };
}
