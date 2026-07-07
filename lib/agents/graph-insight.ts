// Graph-reasoning insights for the Chief of Staff roster.
//
// This is where the roster stops reasoning over *counts* and starts reasoning over
// *relationships*. It delegates to the shared reasoning core (lib/reasoning/insights
// over a FamilyContext) so the roster, the Daily Briefing, and every other AI
// surface reason from ONE engine (moat R2/R7), then maps the result into the
// roster's AgentItem shape. The agents page feeds these into runAllAgents'
// extraItems so they join the Chief of Staff's synthesis.

import { buildFamilyContext } from '@/lib/reasoning/context';
import { familyInsights } from '@/lib/reasoning/insights';
import type { Graph } from '@/lib/graph/reason';
import type { AgentItem } from './roster';

const GRAPH_HREF = '/dashboard/graph';

export function graphInsights(graph: Graph): AgentItem[] {
  const ctx = buildFamilyContext('', graph);
  return familyInsights(ctx).map((i) => ({
    title: i.title,
    detail: i.detail,
    href: GRAPH_HREF,
    severity: 'info',
  }));
}
