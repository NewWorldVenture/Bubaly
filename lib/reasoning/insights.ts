// lib/reasoning/insights.ts — R2: relationship-level reasoning any engine can consume.
//
// R1 gave us `FamilyContext` (graph + live snapshot + operating index). This turns
// that context into insights a *count-based* engine can't produce — the payoff of
// the Knowledge Graph: which node is a coordination hub and how far a change to it
// ripples, whether the household's current pressure concentrates on that hub, and
// which things aren't linked up yet. Pure + unit-tested; engines/surfaces (Calm,
// briefings, the Chief of Staff) fold these in alongside their other signals.

import { impactFrom, type FamilyContext } from '@/lib/reasoning/context';
import {
  buildIndex, hubs as graphHubs, orphans as graphOrphans, propagateImpact, soleDependencies,
  type Graph, type GraphEntity, type SoleDependency,
} from '@/lib/graph/reason';
import type { Band } from '@/lib/operating-index/score';

export type ReasoningInsightKind = 'hub' | 'ripple' | 'coverage' | 'fragility';
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

/** The reasoning primitives the rules run on — sourced either from a full
 *  FamilyContext or from a graph + a known operating-index band. */
type InsightParts = {
  hubs: Array<{ entity: GraphEntity; degree: number }>;
  orphanCount: number;
  band: Band;
  entityCount: number;
  /** outgoing impact blast-radius size from an entity. */
  rippleCountFor: (entityId: string) => number;
  /** people who are the SOLE backup for things (bus-factor), most-loaded first. */
  sole: SoleDependency[];
};

/** The shared rule set — one place, two entry points. */
function buildInsights(p: InsightParts): ReasoningInsight[] {
  const out: ReasoningInsight[] = [];
  if (p.entityCount === 0) return out;

  const top = p.hubs[0];
  const rippleCount = top ? p.rippleCountFor(top.entity.id) : 0;

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
  const band = p.band;
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
  if (p.orphanCount >= 3) {
    out.push({
      id: 'coverage',
      kind: 'coverage',
      title: `${p.orphanCount} things aren't linked yet`,
      detail: 'Connect them in the graph so the assistant can reason about their dependencies.',
      href: GRAPH_HREF,
      severity: 'info',
    });
  }

  // 4) Fragility / bus-factor — one person is the SOLE backup for several things.
  //    Distinct from a hub (that's coordination LOAD); this is "no redundancy":
  //    if this person is unavailable, these responsibilities have nobody else.
  //    The mental-load north-star made concrete — and more urgent when stretched.
  const soleTop = p.sole[0];
  if (soleTop && soleTop.dependents.length >= 3) {
    const names = soleTop.dependents.slice(0, 3).map((d) => d.name).join(', ');
    const more = soleTop.dependents.length > 3 ? `, +${soleTop.dependents.length - 3} more` : '';
    out.push({
      id: `fragility:${soleTop.person.id}`,
      kind: 'fragility',
      title: `${soleTop.person.name} is the only backup for ${soleTop.dependents.length} things`,
      detail: `No one else is linked to ${names}${more}. If ${soleTop.person.name} is unavailable these have no backup — share or cross-link them.`,
      href: GRAPH_HREF,
      severity: band === 'stretched' || band === 'overloaded' ? 'action' : 'attention',
    });
  }

  return out;
}

/**
 * Relationship insights from a full family reasoning context (R1). Deterministic
 * and DB-free. Returns [] for an empty graph so callers can fold it in blindly.
 */
export function reasoningInsights(ctx: FamilyContext): ReasoningInsight[] {
  return buildInsights({
    hubs: ctx.hubs,
    orphanCount: ctx.orphanCount,
    band: ctx.operatingIndex.band,
    entityCount: ctx.stats.entities,
    rippleCountFor: (id) => impactFrom(ctx, id).length,
    sole: soleDependencies(ctx.graphIndex, { minDependents: 3 }),
  });
}

/**
 * Same insights from a bare graph + a known operating-index band — for callers
 * that already computed the band (e.g. the FOI page) and want to avoid a second
 * snapshot build. Builds the graph index once, internally.
 */
export function graphReasoningInsights(graph: Graph, band: Band): ReasoningInsight[] {
  if (graph.entities.length === 0) return [];
  const index = buildIndex(graph);
  return buildInsights({
    hubs: graphHubs(index, 5),
    orphanCount: graphOrphans(index).length,
    band,
    entityCount: graph.entities.length,
    rippleCountFor: (id) => propagateImpact(index, id).length,
    sole: soleDependencies(index, { minDependents: 3 }),
  });
}
