// lib/reasoning/insights.ts — relationship-level insights every AI surface can
// fold into its reasoning (moat R2). Where the rest of the product reasons over
// *counts* ("3 bills due"), this reasons over *relationships* in the family's
// knowledge graph: which node is the coordination hub the week pivots on, how far
// a change to it ripples, and how much of the household isn't linked up yet.
//
// Pure + unit-tested. It consumes a FamilyContext (lib/reasoning/context.ts) so it
// works identically for the Chief of Staff roster, the Daily Briefing grounding,
// the Concierge, and anything else — one reasoning core, many surfaces.

import { orphans, propagateImpact } from '@/lib/graph/reason';
import type { FamilyContext } from './context';

export type InsightKind = 'hub' | 'unlinked';
export type InsightSeverity = 'info' | 'attention';

export interface FamilyInsight {
  kind: InsightKind;
  title: string;
  detail: string;
  severity: InsightSeverity;
  /** Graph entity this insight centres on, when there is one. */
  entityId?: string;
}

export interface InsightOptions {
  /** Minimum edges for a node to count as a coordination "hub". Default 3. */
  hubMinDegree?: number;
  /** How many hubs to surface. Default 1. */
  maxHubs?: number;
  /** Minimum unlinked entities before it's worth flagging. Default 3. */
  unlinkedMinCount?: number;
}

/**
 * Relationship insights for a family, derived purely from the graph. Returns an
 * empty list for an empty/unlinked graph so every caller degrades gracefully.
 */
export function familyInsights(ctx: FamilyContext, opts: InsightOptions = {}): FamilyInsight[] {
  const { hubMinDegree = 3, maxHubs = 1, unlinkedMinCount = 3 } = opts;
  if (ctx.isEmpty) return [];

  const insights: FamilyInsight[] = [];

  // 1) Coordination hubs + blast radius — where the week's coordination concentrates.
  for (const hub of ctx.keyHubs(maxHubs)) {
    if (hub.degree < hubMinDegree) continue;
    const ripple = propagateImpact(ctx.index, hub.entity.id).length;
    const rippleNote = ripple > 0
      ? ` — a change ripples to ${ripple} other ${ripple === 1 ? 'thing' : 'things'}`
      : '';
    insights.push({
      kind: 'hub',
      title: `${hub.entity.name} is a coordination hub`,
      detail: `${hub.degree} things depend on it${rippleNote}. Protect it when plans shift.`,
      severity: 'info',
      entityId: hub.entity.id,
    });
  }

  // 2) Unlinked entities — coverage gaps the assistant can't yet reason about.
  const unlinked = orphans(ctx.index).length;
  if (unlinked >= unlinkedMinCount) {
    insights.push({
      kind: 'unlinked',
      title: `${unlinked} things aren't linked yet`,
      detail: 'Connect them so the assistant can reason about their dependencies.',
      severity: 'info',
    });
  }

  return insights;
}

/** Compact text rendering of the insights for grounding an LLM prompt. */
export function insightsToPromptLines(insights: FamilyInsight[]): string {
  if (insights.length === 0) return '- No linked relationships yet — reasoning is limited to individual items.';
  return insights.map((i) => `- ${i.title} — ${i.detail}`).join('\n');
}
