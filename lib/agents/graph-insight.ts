// Graph-reasoning insights for the Chief of Staff (pure, unit-tested, DB-free).
//
// This is where the roster stops reasoning over *counts* and starts reasoning over
// *relationships*. Given the family's knowledge graph, it surfaces briefing items a
// count-based agent can't: which node is a coordination hub (and how far a change to
// it ripples), and how much of the household isn't linked up yet. The agents page
// feeds these into runAllAgents' extraItems so they join the Chief of Staff's synthesis.

import { buildIndex, hubs, propagateImpact, orphans, type Graph } from '@/lib/graph/reason';
import type { AgentItem } from './roster';

const GRAPH_HREF = '/dashboard/graph';

export function graphInsights(graph: Graph): AgentItem[] {
  const items: AgentItem[] = [];
  if (graph.entities.length === 0) return items;
  const index = buildIndex(graph);

  // 1) The busiest hub + its blast radius — where coordination concentrates.
  const [topHub] = hubs(index, 1);
  if (topHub && topHub.degree >= 3) {
    const ripple = propagateImpact(index, topHub.entity.id).length;
    const rippleNote = ripple > 0 ? ` — a change ripples to ${ripple} other ${ripple === 1 ? 'thing' : 'things'}` : '';
    items.push({
      title: `${topHub.entity.name} is a coordination hub`,
      detail: `${topHub.degree} things depend on it${rippleNote}. Protect it when plans shift.`,
      href: GRAPH_HREF,
      severity: 'info',
    });
  }

  // 2) Unlinked entities — coverage gaps the AI can't reason about yet.
  const unlinked = orphans(index).length;
  if (unlinked >= 3) {
    items.push({
      title: `${unlinked} things aren't linked yet`,
      detail: 'Connect them in the graph so the assistant can reason about their dependencies.',
      href: GRAPH_HREF,
      severity: 'info',
    });
  }

  return items;
}
