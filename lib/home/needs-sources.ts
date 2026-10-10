// lib/home/needs-sources.ts — pure mappers that turn each domain's pending rows
// into Home "Needs you" items (see ./needs-attention.ts for ranking). DOM-free +
// unit-testable. The non-trivial domains (money approvals, renewals) live here;
// the simple count-based signals (reminders, chores) are built inline by the reader.

import type { NeedItem, NeedUrgency } from './needs-attention';
import { runPagePath } from '@/lib/ai/chat-request';
import { inAppHref } from '@/lib/auth/redirect';
import type { LocaleCode } from '@/lib/i18n/locales';
import { formatCents } from '@/lib/wallet/ledger';

/**
 * Who is reading a "needs you" title.
 *
 * Two mappers below put MONEY in a title, and a title is prose: the amount has
 * to be written in the reader's format AND the words around it in the reader's
 * language, or a German parent reads "Card purchase to approve · $25" — the
 * American symbol position inside an English sentence (finalaudit AQ-01 /
 * I18N-003). So both halves travel together, and the field is REQUIRED with no
 * default: every caller has a reader, and a defaulted locale is the parameter
 * nobody passes. A page passes its request's (`getLocaleContext`); a cron or a
 * model-read tool result passes an explicit, commented source locale.
 */
export type NeedsReader = {
  locale: LocaleCode;
  t: (key: string, params?: Record<string, string | number>) => string;
};

/**
 * Compact USD from integer cents, in the reader's format: "$12" / "$12.50" for
 * en-US, "12 $" / "12,50 $" for de-DE. `parent_approvals` carries no currency
 * column — the wallet's approvals are dollars — so the currency is USD.
 */
export function usdFromCents(cents: number, locale: LocaleCode): string {
  return formatCents(cents, 'USD', locale);
}

/** The wallet action each approval kind stands for; the label is a catalogue key. */
const APPROVAL_META: Record<string, { labelKey: string; href: string }> = {
  card_spend: { labelKey: 'needsSources.cardPurchase', href: '/wallet/cards' },
  withdrawal: { labelKey: 'needsSources.withdrawal', href: '/wallet' },
  gift: { labelKey: 'needsSources.gift', href: '/wallet' },
  chore_reward: { labelKey: 'needsSources.choreReward', href: '/wallet' },
  allowance_request: { labelKey: 'needsSources.allowanceRequest', href: '/wallet' },
};

export type ParentApprovalRow = { id: string; kind: string; amount_cents: number | null; created_at: string };

/** A pending money approval → an urgent "needs you" decision card, worded for `reader`. */
export function parentApprovalToNeed(r: ParentApprovalRow, reader: NeedsReader): NeedItem {
  const meta = APPROVAL_META[r.kind] ?? { labelKey: 'needsSources.approval', href: '/wallet' };
  const label = reader.t(meta.labelKey);
  const title = r.amount_cents != null && r.amount_cents > 0
    ? reader.t('needsSources.toApproveWithAmount', { label, amount: usdFromCents(r.amount_cents, reader.locale) })
    : reader.t('needsSources.toApprove', { label });
  return {
    id: `approval:${r.id}`,
    kind: 'approval',
    title,
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

/** Where a recommendation with no link of its own goes: the page that lists them. */
const RECOMMENDATIONS_HREF = '/dashboard/autonomous-family-management';
/**
 * Where one whose stored link would leave the app goes instead: the list of
 * every decision — the same place the morning brief already sends it
 * (lib/briefing/decisions.ts), so Home and the brief agree.
 */
const DECISIONS_HREF = '/dashboard/needs-you';

/**
 * A pending `family_ai_recommendations` row (the household chose "recommend,
 * don't act" — §11 level 1) → a normal-urgency item with one-tap accept/dismiss.
 *
 * `cta_href` is free text on a row any member can write (RLS is
 * `is_family_member` for INSERT and UPDATE, and the generic record action
 * whitelists the column), and this item is shown to a parent on Home, on
 * Needs you and in the brief as Bubaly's own suggestion. Passed through raw,
 * a child could put "Confirm your card — urgent" in front of a parent linking
 * to https://evil.example. The brief refused that; Home did not. So an href
 * that would leave the app is not rendered: the item keeps its place and opens
 * the decisions list instead.
 */
export function recommendationToNeed(r: RecommendationRow): NeedItem {
  const own = r.cta_href?.trim();
  return {
    id: `recommendation:${r.id}`,
    kind: 'recommendation',
    title: r.title,
    href: !own ? RECOMMENDATIONS_HREF : inAppHref(own) ?? DECISIONS_HREF,
    urgency: r.priority === 'high' ? 'urgent' : 'normal',
    createdAt: r.created_at,
  };
}

// ─── Ambiguous facts, messages awaiting a reply, open form actions (M5) ──────
//
// Three more things a household actually decides, none of which reached the
// "Needs you" queue before: a memory Bubaly inferred but nobody confirmed, a
// message to the family's own number/address that is waiting for an answer,
// and a form action (sign / pay / RSVP) extracted from paperwork. Each mapper
// is pure and keeps the same urgency vocabulary as the items above so the one
// ranking (`rankNeedsAttention`) applies across all of them.

/**
 * Compact USD from a dollar amount (paperwork stores dollars, not cents), in the
 * reader's format. An extracted paperwork action carries no currency, so USD.
 */
function usdFromDollars(amount: number, locale: LocaleCode): string {
  return formatCents(Math.round(amount * 100), 'USD', locale);
}

function daysUntil(iso: string, now: Date): number | null {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor((t - now.getTime()) / 86_400_000) : null;
}

/** The columns of a `family_playbook_suggestions` row (status 'suggested') the card needs. */
export type FactSuggestionRow = { id: string; label: string; value: string; expires_at?: string | null; created_at: string };

/**
 * A memory Bubaly inferred and nobody has confirmed → a decision with
 * Confirm / Dismiss on the card. Normal urgency: nothing is waiting on it
 * except Bubaly's own certainty — unless the suggestion carries an expiry
 * that is about to pass, when the window to keep it is closing.
 *
 * A suggestion that has ALREADY lapsed returns null. `confirmFact` refuses
 * it (the fact would be born expired and invisible), so offering it as a
 * decision would put up a button that cannot do what it says.
 */
export function factSuggestionToNeed(r: FactSuggestionRow, now: Date): NeedItem | null {
  let urgency: NeedUrgency = 'normal';
  if (r.expires_at) {
    const days = daysUntil(r.expires_at, now);
    if (days !== null && days < 0) return null;
    if (days !== null && days <= 3) urgency = 'urgent';
  }
  return {
    id: `fact_suggestion:${r.id}`,
    kind: 'fact_suggestion',
    title: `${r.label.trim()}: ${r.value.trim()}`,
    href: `/dashboard/playbook#suggestion-${r.id}`,
    urgency,
    createdAt: r.created_at,
  };
}

/** The columns of a `family_inbox_messages` row the card needs. */
export type InboxMessageRow = {
  id: string;
  direction?: string | null;
  from_addr: string | null;
  subject: string | null;
  ai_summary: string | null;
  body: string | null;
  ai_intent: string | null;
  status: string;
  occurred_at: string;
};

/** Inbound intents a person answers; delivery notices, sales and spam are Bubaly's to file. */
export const REPLY_INTENTS: readonly string[] = ['appointment', 'personal'];

/**
 * An unread inbound message that wants a human answer → a "needs you" item
 * linking to the message in the Contact Center (where it is read, replied to
 * and archived). An appointment is time-bound, so it ranks urgent; a personal
 * note is normal. Anything read, outbound, or of an intent the concierge
 * handles on its own returns null.
 */
export function inboxMessageToNeed(r: InboxMessageRow): NeedItem | null {
  if (r.status !== 'new') return null;
  if (r.direction && r.direction !== 'inbound') return null;
  if (!r.ai_intent || !REPLY_INTENTS.includes(r.ai_intent)) return null;
  const who = r.from_addr?.trim() || 'an unknown sender';
  const gist = r.subject?.trim() || r.ai_summary?.trim() || r.body?.replace(/\s+/g, ' ').trim().slice(0, 80) || '';
  return {
    id: `inbox_message:${r.id}`,
    kind: 'inbox_message',
    title: gist ? `Reply to ${who} — ${gist}` : `Reply to ${who}`,
    href: `/dashboard/contact-center#inbox-message-${r.id}`,
    urgency: r.ai_intent === 'appointment' ? 'urgent' : 'normal',
    createdAt: r.occurred_at,
  };
}

/** The columns of a `paperwork_items` row the mapper needs; `actions` is the raw jsonb. */
export type PaperworkRow = {
  id: string;
  title: string;
  status: string;
  urgency?: string | null;
  due_on: string | null;
  actions: unknown;
  created_at: string;
};

/** The extracted actions a PERSON has to do; schedule/provide/review are follow-ups, not decisions. */
export const PAPERWORK_DECISION_KINDS: readonly string[] = ['sign', 'pay', 'rsvp'];

const PAPERWORK_OPEN_STATUSES: readonly string[] = ['needs_action', 'in_progress'];

type StoredPaperworkAction = { kind?: unknown; label?: unknown; due_on?: unknown; amount?: unknown; materialized_id?: unknown };

/**
 * Every open sign / pay / RSVP action on a piece of paperwork → one "needs
 * you" item each, linking to the item in the Paperwork inbox. Open means the
 * item is still `needs_action`/`in_progress` AND the action has not been
 * materialised into a reminder or event (those already show up through the
 * reminders and calendar sources — a second card would be the same task
 * twice). Urgent within 3 days of the due date, past due, or when the triage
 * marked the whole item urgent.
 *
 * The title is the action's own label and the item's own title (both data, in
 * whatever language the paperwork was in), then the amount in the reader's
 * format and the due date in the reader's words.
 */
export function paperworkActionsToNeeds(r: PaperworkRow, now: Date, reader: NeedsReader): NeedItem[] {
  if (!PAPERWORK_OPEN_STATUSES.includes(r.status)) return [];
  if (!Array.isArray(r.actions)) return [];
  const out: NeedItem[] = [];
  (r.actions as StoredPaperworkAction[]).forEach((a, index) => {
    if (!a || typeof a !== 'object') return;
    const kind = typeof a.kind === 'string' ? a.kind : '';
    if (!PAPERWORK_DECISION_KINDS.includes(kind)) return;
    if (a.materialized_id) return;
    const label = typeof a.label === 'string' && a.label.trim() ? a.label.trim() : kind.toUpperCase();
    const amount = typeof a.amount === 'number' && a.amount > 0 ? usdFromDollars(a.amount, reader.locale) : null;
    const dueOn = typeof a.due_on === 'string' && a.due_on ? a.due_on : r.due_on;
    const days = dueOn ? daysUntil(dueOn, now) : null;
    const when = days === null
      ? null
      : days < 0 ? reader.t('needsSources.overdue')
        : days === 0 ? reader.t('needsSources.dueToday')
          : reader.t('needsSources.dueInDays', { days });
    const details = [amount, when].filter((part): part is string => part !== null).map((part) => ` · ${part}`).join('');
    const urgency: NeedUrgency = (days !== null && days <= 3) || r.urgency === 'urgent' ? 'urgent' : 'normal';
    out.push({
      id: `paperwork:${r.id}:${index}`,
      kind: `paperwork_${kind}`,
      title: `${label} — ${r.title}${details}`,
      href: `/dashboard/paperwork#paperwork-${r.id}`,
      urgency,
      createdAt: r.created_at,
    });
  });
  return out;
}
