// lib/family/knowledge.ts
// Pure graph helpers for the Family Knowledge Graph. Builds adjacency, ranks
// the most-connected nodes, and lays nodes out on a circle for SVG rendering.

export type GraphNode = {
  id: string;
  label: string;
  type: string;
};

export type GraphEdge = {
  source: string;
  target: string;
  relation: string;
};

export type Positioned = GraphNode & { x: number; y: number; degree: number };

/** Counts undirected connections per node id. */
export function degreeMap(edges: GraphEdge[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of edges) {
    m.set(e.source, (m.get(e.source) ?? 0) + 1);
    m.set(e.target, (m.get(e.target) ?? 0) + 1);
  }
  return m;
}

/** Node ids ordered by descending degree (most connected first). */
export function mostConnected(nodes: GraphNode[], edges: GraphEdge[], limit = 5): Positioned[] {
  const deg = degreeMap(edges);
  return nodes
    .map((n) => ({ ...n, x: 0, y: 0, degree: deg.get(n.id) ?? 0 }))
    .sort((a, b) => b.degree - a.degree)
    .slice(0, limit);
}

/**
 * Circular layout: members near the center ring, everything else on an outer
 * ring, so the SVG reads as a family-centric hub-and-spoke.
 */
export function layout(
  nodes: GraphNode[],
  edges: GraphEdge[],
  opts: { width: number; height: number } = { width: 600, height: 600 },
): Positioned[] {
  const deg = degreeMap(edges);
  const cx = opts.width / 2;
  const cy = opts.height / 2;
  const members = nodes.filter((n) => n.type === 'member');
  const others = nodes.filter((n) => n.type !== 'member');

  const place = (list: GraphNode[], radius: number): Positioned[] =>
    list.map((n, i) => {
      const angle = list.length ? (i / list.length) * Math.PI * 2 - Math.PI / 2 : 0;
      return {
        ...n,
        degree: deg.get(n.id) ?? 0,
        x: cx + radius * Math.cos(angle),
        y: cy + radius * Math.sin(angle),
      };
    });

  const inner = Math.min(opts.width, opts.height) * 0.18;
  const outer = Math.min(opts.width, opts.height) * 0.42;
  return [...place(members, members.length === 1 ? 0 : inner), ...place(others, outer)];
}

/** Resolves edge endpoints to coordinates, dropping edges with a missing node. */
export function edgeLines(
  edges: GraphEdge[],
  positioned: Positioned[],
): Array<{ x1: number; y1: number; x2: number; y2: number; relation: string }> {
  const byId = new Map(positioned.map((p) => [p.id, p]));
  const lines = [];
  for (const e of edges) {
    const a = byId.get(e.source);
    const b = byId.get(e.target);
    if (!a || !b) continue;
    lines.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, relation: e.relation });
  }
  return lines;
}
