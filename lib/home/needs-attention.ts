// lib/home/needs-attention.ts — the deterministic core of Home "Mission Control".
// PURE + tested.
//
// The five-surface vision (see docs/FRICTIONLESS_UX_ROADMAP.md) makes Home answer
// "what needs me right now?" by unioning cross-domain pending items — wallet/
// economy/invest approvals, trust approvals, chore sign-offs, renewals, calendar
// conflicts, concierge outcomes — and ranking them by urgency then recency.
//
// This module is the ranking/aggregation brain only (no I/O), so a server reader
// can map each domain's pending rows into `NeedItem`s and call `rankNeedsAttention`.
// Keeping it pure means it's unit-tested without a database (node-only vitest).

export type NeedUrgency = 'emergency' | 'urgent' | 'normal';

/** A single "needs you" item, domain-agnostic, ready to render as a Home card. */
export type NeedItem = {
  id: string;
  /** Source domain, e.g. 'wallet_approval' | 'economy_redemption' | 'invest_order' | 'trust_approval' | 'renewal' | 'calendar_conflict'. */
  kind: string;
  title: string;
  /** Where tapping the card takes the user to act. */
  href: string;
  urgency: NeedUrgency;
  /** ISO timestamp used as the tiebreaker (newest first). */
  createdAt: string;
  /** Optional grouping count when multiple items collapse into one card. */
  count?: number;
};

const URGENCY_RANK: Record<NeedUrgency, number> = { emergency: 0, urgent: 1, normal: 2 };

/** Coerce arbitrary input to a known urgency (defaults to 'normal'). */
export function normalizeUrgency(value: unknown): NeedUrgency {
  return value === 'emergency' || value === 'urgent' || value === 'normal' ? value : 'normal';
}

function timeValue(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Rank items for the Home surface: most urgent first, then newest first, then a
 * stable kind/id tiebreak so the order is deterministic (important for tests +
 * no UI jitter between renders). Returns a new array; never mutates the input.
 */
export function rankNeedsAttention(items: NeedItem[]): NeedItem[] {
  return [...(items ?? [])].sort((a, b) => {
    const u = URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency];
    if (u !== 0) return u;
    const t = timeValue(b.createdAt) - timeValue(a.createdAt); // newest first
    if (t !== 0) return t;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export type NeedsSummary = {
  total: number;
  emergency: number;
  urgent: number;
  byKind: Record<string, number>;
};

/** Totals for the Home header ("3 things need you") + per-domain counts. */
export function summarizeNeeds(items: NeedItem[]): NeedsSummary {
  const out: NeedsSummary = { total: 0, emergency: 0, urgent: 0, byKind: {} };
  for (const it of items ?? []) {
    const n = Math.max(1, Math.trunc(it.count ?? 1));
    out.total += n;
    if (it.urgency === 'emergency') out.emergency += n;
    if (it.urgency === 'urgent') out.urgent += n;
    out.byKind[it.kind] = (out.byKind[it.kind] ?? 0) + n;
  }
  return out;
}

/** A calm, human header line for the Home "Needs you" section. */
export function needsHeadline(summary: NeedsSummary): string {
  if (summary.total === 0) return "You're all caught up — nothing needs you right now.";
  const noun = summary.total === 1 ? 'thing needs' : 'things need';
  if (summary.emergency > 0) return `${summary.total} ${noun} you — including something urgent.`;
  return `${summary.total} ${noun} you.`;
}

/** Cap the cards shown on Home; the rest roll into a "+N more" affordance. */
export function topNeeds(items: NeedItem[], limit = 5): { shown: NeedItem[]; more: number } {
  const ranked = rankNeedsAttention(items);
  return { shown: ranked.slice(0, limit), more: Math.max(0, ranked.length - limit) };
}
