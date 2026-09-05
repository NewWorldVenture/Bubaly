// lib/home/needs-sources.ts — pure mappers that turn each domain's pending rows
// into Home "Needs you" items (see ./needs-attention.ts for ranking). DOM-free +
// unit-testable. The non-trivial domains (money approvals, renewals) live here;
// the simple count-based signals (reminders, chores) are built inline by the reader.

import type { NeedItem, NeedUrgency } from './needs-attention';
import { runPagePath } from '@/lib/ai/chat-request';

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

export type DocumentRow = { id: string; title: string; expires_at: string | null };

/**
 * A stored document with an expiry (passport, license, insurance card…) → a
 * "needs you" item once it's within `windowDays` of expiring (or already
 * expired). Urgent within 3 days / past due. null when not yet due or undated.
 */
export function documentExpiryToNeed(r: DocumentRow, now: Date, windowDays = 30): NeedItem | null {
  if (!r.expires_at) return null;
  const t = Date.parse(r.expires_at);
  if (!Number.isFinite(t)) return null;
  const days = Math.floor((t - now.getTime()) / 86_400_000);
  if (days > windowDays) return null;
  const when = days < 0 ? 'expired' : days === 0 ? 'expires today' : `expires in ${days}d`;
  const urgency: NeedUrgency = days <= 3 ? 'urgent' : 'normal';
  return {
    id: `document:${r.id}`,
    kind: 'document',
    title: `${r.title} — ${when}`,
    href: '/dashboard/documents',
    urgency,
    createdAt: r.expires_at,
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

// ─── Bubaly's own asks (§16 "Needs Your Attention") ──────────────────────────

/** The columns of an `approval_requests` row the Home card needs — a subset of `ApprovalCardData`. */
export type AiApprovalRow = { id: string; title: string; runId: string | null; priority?: string | null; requestedAt: string; expiresAt?: string | null };

/**
 * A pending AI approval → an urgent decision. It deep-links to the run page
 * when the approval gates a run (the page shows the approval inline with the
 * steps it would release) and to the trust inbox otherwise.
 */
export function aiApprovalToNeed(r: AiApprovalRow): NeedItem {
  return {
    id: `ai_approval:${r.id}`,
    kind: 'ai_approval',
    title: r.title,
    href: r.runId ? runPagePath(r.runId) : '/dashboard/trust',
    urgency: r.priority === 'high' || r.priority === 'urgent' ? 'emergency' : 'urgent',
    createdAt: r.requestedAt,
  };
}

export type AwaitingRunRow = { id: string; summary: string | null; state: string; updated_at: string; created_at?: string };

/**
 * A run parked on a person → a "needs you" item: `awaiting_approval` when
 * Bubaly is waiting for an OK, `awaiting_context` when it asked a question.
 * Any other state returns null — a run that is executing needs nobody.
 */
export function awaitingRunToNeed(r: AwaitingRunRow): NeedItem | null {
  const title = r.summary?.trim() || 'A request from your family';
  if (r.state === 'awaiting_approval') {
    return { id: `run:${r.id}`, kind: 'run_awaiting_approval', title: `${title} — waiting for your OK`, href: runPagePath(r.id), urgency: 'urgent', createdAt: r.updated_at };
  }
  if (r.state === 'awaiting_context') {
    return { id: `run:${r.id}`, kind: 'run_awaiting_answer', title: `${title} — Bubaly has a question`, href: runPagePath(r.id), urgency: 'urgent', createdAt: r.updated_at };
  }
  return null;
}

export type RecommendationRow = { id: string; title: string; priority?: string | null; cta_href?: string | null; created_at: string };

/**
 * A pending `family_ai_recommendations` row (the household chose "recommend,
 * don't act" — §11 level 1) → a normal-urgency item with one-tap accept/dismiss.
 */
export function recommendationToNeed(r: RecommendationRow): NeedItem {
  return {
    id: `recommendation:${r.id}`,
    kind: 'recommendation',
    title: r.title,
    href: r.cta_href?.trim() || '/dashboard/autonomous-family-management',
    urgency: r.priority === 'high' ? 'urgent' : 'normal',
    createdAt: r.created_at,
  };
}
