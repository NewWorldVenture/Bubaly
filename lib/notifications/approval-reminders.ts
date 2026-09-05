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

// ─── AI approvals (approval_requests) ───────────────────────────────────────
//
// The block above is the wallet inbox (`parent_approvals`). The rows below are
// the trust-engine inbox (`approval_requests`, 0093/0251): Bubaly proposing an
// action that a household policy or the risk tier said needs a person. The two
// stay separate builders because they differ in exactly the ways that matter
// for the wording — an AI approval has a title the planner wrote and an expiry
// after which the run blocks, while a wallet approval has a kind and an amount.

export interface AiApprovalInput {
  id: string;
  title: string;
  amount_cents: number | null;
  created_at: string;
  expires_at: string | null;
  agent: string | null;
}

export interface AiApprovalReminder {
  approval_id: string;
  /** `family_members.id` of the manager to notify. */
  member_id: string;
  user_id: string;
  /** Stored as `notifications.related_id`; the natural key the sweep dedupes on. */
  dedupe_key: string;
  type: 'system';
  related_type: 'approval_requests';
  related_id: string;
  title: string;
  body: string;
}

/**
 * One notification per (approval, manager). `notifications` has no dedupe
 * column, so the key IS `related_id`: the notify service refuses a second
 * unread row with the same `(type, related_id, user_id)`, and the reminder
 * sweep additionally checks the key against every row ever written, which is
 * what makes "one reminder per pending AI approval" hold across cron ticks and
 * after the manager has read it.
 */
export function aiApprovalDedupeKey(approvalId: string, memberId: string): string {
  return `ai-approval:${approvalId}:${memberId}`;
}

function expiryPhrase(expiresAt: string | null, now: Date): string | null {
  if (!expiresAt) return null;
  const ms = Date.parse(expiresAt) - now.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const hours = ms / 3_600_000;
  if (hours < 1) return 'Expires within the hour';
  if (hours < 36) return `Expires in ${Math.round(hours)}h`;
  return `Expires in ${Math.round(hours / 24)} days`;
}

/**
 * The reminder rows for a family's pending AI approvals. Managers with no
 * login (managed profiles) are skipped rather than folded into a family-wide
 * row: a family-wide reminder would reach the children too, and a pending
 * approval is precisely the thing they should not be nagged about.
 */
export function aiApprovalReminders(approvals: AiApprovalInput[], managers: ManagerLite[], now: Date = new Date()): AiApprovalReminder[] {
  const out: AiApprovalReminder[] = [];
  for (const a of approvals ?? []) {
    const amount = a.amount_cents != null && a.amount_cents > 0 ? ` · ${usd(a.amount_cents)}` : '';
    const expiry = expiryPhrase(a.expires_at, now);
    const body = [
      `Bubaly is waiting for your OK before it goes ahead${a.agent ? ` (${a.agent})` : ''}.`,
      expiry,
    ].filter(Boolean).join(' ');
    for (const m of managers ?? []) {
      if (!m.user_id) continue;
      const key = aiApprovalDedupeKey(a.id, m.id);
      out.push({
        approval_id: a.id,
        member_id: m.id,
        user_id: m.user_id,
        dedupe_key: key,
        type: 'system',
        related_type: 'approval_requests',
        related_id: key,
        title: `Needs your OK: ${a.title}${amount}`,
        body,
      });
    }
  }
  return out;
}
