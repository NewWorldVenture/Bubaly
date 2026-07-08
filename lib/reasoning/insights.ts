// lib/reasoning/insights.ts — R2: relationship-level reasoning any engine can consume.
//
// R1 gave us `FamilyContext` (graph + live snapshot + operating index). This turns
// that context into insights a *count-based* engine can't produce — the payoff of
// the Knowledge Graph: which node is a coordination hub and how far a change to it
// ripples, whether the household's current pressure concentrates on that hub, and
// which things aren't linked up yet. Pure + unit-tested; engines/surfaces (Calm,
// briefings, the Chief of Staff) fold these in alongside their other signals.

import { impactFrom, type FamilyContext } from '@/lib/reasoning/context';

export type ReasoningInsightKind = 'hub' | 'ripple' | 'coverage';
export type InsightSeverity = 'action' | 'attention' | 'info';

export type ReasoningInsight = {
  id: string;
  kind: ReasoningInsightKind;
  title: string;
  detail: string;
  href: string;
  severity: InsightSeverity;
};

const GRAPH_HREF = '/dashboard/graph';

/**
 * Derive relationship-level insights from a family reasoning context. Deterministic
 * and DB-free. Returns [] for an empty graph so callers can fold it in blindly.
 */
export function reasoningInsights(ctx: FamilyContext): ReasoningInsight[] {
  const out: ReasoningInsight[] = [];
  if (ctx.stats.entities === 0) return out;

  const top = ctx.hubs[0];
  const rippleCount = top ? impactFrom(ctx, top.entity.id).length : 0;

  // 1) The coordination hub + its blast radius — where coordination concentrates.
  if (top && top.degree >= 3) {
    const rippleNote = rippleCount > 0
      ? ` — a change ripples to ${rippleCount} other ${rippleCount === 1 ? 'thing' : 'things'}`
      : '';
    out.push({
      id: `hub:${top.entity.id}`,
      kind: 'hub',
      title: `${top.entity.name} is a coordination hub`,
      detail: `${top.degree} things depend on it${rippleNote}. Protect it when plans shift.`,
      href: GRAPH_HREF,
      severity: top.degree >= 6 ? 'attention' : 'info',
    });
  }

  // 2) Ripple risk — the graph × the live snapshot. When the household is stretched
  //    or overloaded AND coordination concentrates on a hub, a single change there is
  //    high-impact. This is the reasoning a count-only engine can't do.
  const band = ctx.operatingIndex.band;
  if ((band === 'stretched' || band === 'overloaded') && top && top.degree >= 4 && rippleCount >= 3) {
    out.push({
      id: `ripple:${top.entity.id}`,
      kind: 'ripple',
      title: `A change to ${top.entity.name} would ripple wide right now`,
      detail: `The week is ${band} and ${top.entity.name} touches ${rippleCount} other things — reschedule around it, not through it.`,
      href: GRAPH_HREF,
      severity: 'attention',
    });
  }

  // 3) Coverage gaps — unlinked entities the AI can't yet reason about.
  if (ctx.orphanCount >= 3) {
    out.push({
      id: 'coverage',
      kind: 'coverage',
      title: `${ctx.orphanCount} things aren't linked yet`,
      detail: 'Connect them in the graph so the assistant can reason about their dependencies.',
      href: GRAPH_HREF,
      severity: 'info',
    });
  }

  return out;
}
