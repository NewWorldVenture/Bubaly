// lib/notifications/approval-reminders.ts — pure builder for "a decision is
// waiting on you" notifications. A parent shouldn't have to open the app to
// discover a pending money approval; Bubaly tells them. Mirrors the renewal/
// opportunity deadline builders. DOM-free + unit-testable.

import type { ManagerLite } from './deadline-reminders';

export interface ApprovalInput {
  id: string;
  kind: string;
  amount_cents: number | null;
  created_at: string;
}

export interface ApprovalReminder {
  type: 'system';
  related_type: 'parent_approvals';
  related_id: string;
  title: string;
  body: string | null;
  user_id: string | null;
}

const LABEL: Record<string, string> = {
  card_spend: 'Card purchase',
  withdrawal: 'Withdrawal',
  gift: 'Gift',
  chore_reward: 'Chore reward',
  allowance_request: 'Allowance request',
};

function usd(cents: number): string {
  const v = cents / 100;
  return Number.isInteger(v) ? `$${v}` : `$${v.toFixed(2)}`;
}

/**
 * One decision-request notification per manager for each pending money approval
 * (per-manager `related_id` keeps the (type, related_id, user_id) dedup unique,
 * so each parent is alerted exactly once). Falls back to a whole-family
 * notification when the family has no managers.
 */
export function approvalReminders(approvals: ApprovalInput[], managers: ManagerLite[]): ApprovalReminder[] {
  const out: ApprovalReminder[] = [];
  for (const a of approvals ?? []) {
    const label = LABEL[a.kind] ?? 'Approval';
    const amount = a.amount_cents != null && a.amount_cents > 0 ? ` · ${usd(a.amount_cents)}` : '';
    const base = {
      type: 'system' as const,
      related_type: 'parent_approvals' as const,
      title: `Approval needed: ${label}${amount}`,
      body: 'A family member is waiting — tap to review in Family Wallet.',
    };
    if (managers.length === 0) {
      out.push({ ...base, related_id: a.id, user_id: null });
    } else {
      for (const m of managers) out.push({ ...base, related_id: `${a.id}:${m.id}`, user_id: m.user_id });
    }
  }
  return out;
}
