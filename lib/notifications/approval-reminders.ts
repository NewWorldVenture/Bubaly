// lib/notifications/approval-reminders.ts — pure builder for "a decision is
// waiting on you" notifications. A parent shouldn't have to open the app to
// discover a pending money approval; Bubaly tells them. Mirrors the renewal/
// opportunity deadline builders. DOM-free + unit-testable.
//
// WHO THE WORDS ARE FOR. Both builders put MONEY in a title, and a title is
// prose: the amount has to be in the reader's format AND the sentence around it
// in the reader's language, or a German parent reads "Approval needed: Card
// purchase · $25" — the American symbol position inside an English sentence
// (finalaudit AQ-01 / I18N-003). So every call names its reader, REQUIRED and
// with no default, because a defaulted locale is the parameter nobody passes.
//
// GROUNDWORK, NOT YET A CONVERSION. Today both callers are sweeps that write
// one row per manager with no recipient locale to read (I18N-001: no member or
// family table stores a language choice yet, and `notifications` has no facts
// column a screen could re-word from), so the only reader either builder ever
// receives is an explicit, commented 'en-US' constant — see
// lib/server/notifications.ts and lib/services/approvals/index.ts. Every
// manager, a German one included, still reads the English sentence with the
// American amount in the bell and in push. What this change did is move the
// prose into the catalogue and remove the hand-written symbol, so that a
// per-recipient locale, when it exists, is a one-line change at each call site
// rather than a rewrite here.

import type { ManagerLite } from './deadline-reminders';
import type { NeedsReader } from '@/lib/home/needs-sources';
import { formatCents } from '@/lib/wallet/ledger';

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

/** The wallet action each approval kind stands for — the same catalogue keys Home's "Needs you" list uses. */
const LABEL_KEY: Record<string, string> = {
  card_spend: 'needsSources.cardPurchase',
  withdrawal: 'needsSources.withdrawal',
  gift: 'needsSources.gift',
  chore_reward: 'needsSources.choreReward',
  allowance_request: 'needsSources.allowanceRequest',
};

/**
 * The amount in the reader's format: "$25" / "$10.50" for en-US, "25 $" /
 * "10,50 $" for de-DE. Neither `parent_approvals` nor `approval_requests`
 * carries a currency column — the wallet's approvals are dollars — so USD.
 */
function amountFor(cents: number, reader: NeedsReader): string {
  return formatCents(cents, 'USD', reader.locale);
}

/**
 * One decision-request notification per manager for each pending money approval
 * (per-manager `related_id` keeps the (type, related_id, user_id) dedup unique,
 * so each parent is alerted exactly once). Falls back to a whole-family
 * notification when the family has no managers. Worded for `reader`.
 */
export function approvalReminders(approvals: ApprovalInput[], managers: ManagerLite[], reader: NeedsReader): ApprovalReminder[] {
  const out: ApprovalReminder[] = [];
  for (const a of approvals ?? []) {
    const label = reader.t(LABEL_KEY[a.kind] ?? 'needsSources.approval');
    const title = a.amount_cents != null && a.amount_cents > 0
      ? reader.t('approvalReminders.titleWithAmount', { label, amount: amountFor(a.amount_cents, reader) })
      : reader.t('approvalReminders.title', { label });
    const base = {
      type: 'system' as const,
      related_type: 'parent_approvals' as const,
      title,
      body: reader.t('approvalReminders.body'),
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

function expiryPhrase(expiresAt: string | null, now: Date, t: NeedsReader['t']): string | null {
  if (!expiresAt) return null;
  const ms = Date.parse(expiresAt) - now.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const hours = ms / 3_600_000;
  if (hours < 1) return t('aiApprovalReminders.expiresWithinHour');
  if (hours < 36) return t('aiApprovalReminders.expiresInHours', { hours: Math.round(hours) });
  // 36h rounds to 2 days, so `days` is never 1 and the sentence needs no plural.
  return t('aiApprovalReminders.expiresInDays', { days: Math.round(hours / 24) });
}

/**
 * The reminder rows for a family's pending AI approvals, worded for `reader`.
 * Managers with no login (managed profiles) are skipped rather than folded
 * into a family-wide row: a family-wide reminder would reach the children too,
 * and a pending approval is precisely the thing they should not be nagged about.
 */
export function aiApprovalReminders(approvals: AiApprovalInput[], managers: ManagerLite[], reader: NeedsReader, now: Date = new Date()): AiApprovalReminder[] {
  const out: AiApprovalReminder[] = [];
  for (const a of approvals ?? []) {
    const title = a.amount_cents != null && a.amount_cents > 0
      ? reader.t('aiApprovalReminders.titleWithAmount', { title: a.title, amount: amountFor(a.amount_cents, reader) })
      : reader.t('aiApprovalReminders.title', { title: a.title });
    const waiting = a.agent
      ? reader.t('aiApprovalReminders.waitingAgent', { agent: a.agent })
      : reader.t('aiApprovalReminders.waiting');
    const expiry = expiryPhrase(a.expires_at, now, reader.t);
    const body = [waiting, expiry].filter(Boolean).join(' ');
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
        title,
        body,
      });
    }
  }
  return out;
}
