// Family Knowledge Graph — the reasoning engine (pure, unit-tested, DB-free).
//
// The graph turns isolated household data into linked, typed nodes + edges so the
// AI can *reason across relationships* instead of retrieving rows. This module is
// the traversal + inference core: build an index, walk neighbours, find the path
// between two things, and — the payoff — propagate IMPACT along edges (weather
// affects the field, which affects the game, which affects travel, which affects
// dinner). The route/UI feed it real Supabase rows; every rule here is testable.

export type EntityKind =
  | 'person' | 'activity' | 'place' | 'org' | 'event' | 'item' | 'pet' | 'topic' | 'other';

export type GraphEntity = {
  id: string;
  kind: EntityKind;
  name: string;
  refTable?: string | null;
  refId?: string | null;
  attributes?: Record<string, unknown>;
};

export type GraphEdge = {
  id: string;
  sourceId: string;
  targetId: string;
  relation: string;
  /** 0..1 edge strength; higher = a stronger dependency for impact propagation. */
  weight: number;
  attributes?: Record<string, unknown>;
};

export type Graph = { entities: GraphEntity[]; edges: GraphEdge[] };

/** Indexed view of a graph for O(1) node lookup + adjacency walks. */
export type GraphIndex = {
  byId: Map<string, GraphEntity>;
  /** outgoing edges keyed by source id. */
  out: Map<string, GraphEdge[]>;
  /** incoming edges keyed by target id. */
  in: Map<string, GraphEdge[]>;
};

export function buildIndex(graph: Graph): GraphIndex {
  const byId = new Map<string, GraphEntity>();
  const out = new Map<string, GraphEdge[]>();
  const inc = new Map<string, GraphEdge[]>();
  for (const e of graph.entities) byId.set(e.id, e);
  for (const edge of graph.edges) {
    // ignore dangling edges whose endpoints aren't in the entity set
    if (!byId.has(edge.sourceId) || !byId.has(edge.targetId)) continue;
    (out.get(edge.sourceId) ?? out.set(edge.sourceId, []).get(edge.sourceId)!).push(edge);
    (inc.get(edge.targetId) ?? inc.set(edge.targetId, []).get(edge.targetId)!).push(edge);
  }
  return { byId, out, in: inc };
}

/** Direct neighbours of a node (both directions), de-duplicated, with the relation. */
export type Neighbour = { entity: GraphEntity; relation: string; direction: 'out' | 'in'; weight: number };

export function neighbours(index: GraphIndex, id: string): Neighbour[] {
  const result: Neighbour[] = [];
  for (const e of index.out.get(id) ?? []) {
    const entity = index.byId.get(e.targetId);
    if (entity) result.push({ entity, relation: e.relation, direction: 'out', weight: e.weight });
  }
  for (const e of index.in.get(id) ?? []) {
    const entity = index.byId.get(e.sourceId);
    if (entity) result.push({ entity, relation: e.relation, direction: 'in', weight: e.weight });
  }
  return result;
}

/**
 * Shortest relationship path between two entities (BFS over an undirected view —
 * relationships connect both ways for "how are these related?" queries).
 * Returns the ordered list of entities, or null if unconnected.
 */
export function findPath(index: GraphIndex, fromId: string, toId: string): GraphEntity[] | null {
  if (!index.byId.has(fromId) || !index.byId.has(toId)) return null;
  if (fromId === toId) return [index.byId.get(fromId)!];
  const prev = new Map<string, string>();
  const seen = new Set<string>([fromId]);
  const queue: string[] = [fromId];
  while (queue.length) {
    const cur = queue.shift()!;
    const adj = [
      ...(index.out.get(cur) ?? []).map((e) => e.targetId),
      ...(index.in.get(cur) ?? []).map((e) => e.sourceId),
    ];
    for (const next of adj) {
      if (seen.has(next)) continue;
      seen.add(next);
      prev.set(next, cur);
      if (next === toId) {
        // reconstruct
        const path: string[] = [toId];
        let step = toId;
        while (step !== fromId) { step = prev.get(step)!; path.push(step); }
        return path.reverse().map((pid) => index.byId.get(pid)!);
      }
      queue.push(next);
    }
  }
  return null;
}

/**
 * All entities reachable from a node within `maxDepth` hops (the node's
 * "neighbourhood" — everything that touches it), nearest first.
 */
export function reachable(index: GraphIndex, id: string, maxDepth = 2): Array<{ entity: GraphEntity; depth: number }> {
  const out: Array<{ entity: GraphEntity; depth: number }> = [];
  const seen = new Set<string>([id]);
  let frontier = [id];
  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const n of neighbours(index, cur)) {
        if (seen.has(n.entity.id)) continue;
        seen.add(n.entity.id);
        out.push({ entity: n.entity, depth });
        next.push(n.entity.id);
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * IMPACT PROPAGATION — the reasoning payoff. Something changes at `sourceId`
 * (a rained-out field, a sick child, a delayed flight). Follow OUTGOING edges
 * and multiply weights to score how strongly each downstream entity is affected.
 * Returns affected entities sorted by descending impact, so the Chief of Staff
 * can surface the real blast radius ("this also hits: the game, carpool, dinner").
 */
export type Impact = { entity: GraphEntity; score: number; via: string };

export function propagateImpact(
  index: GraphIndex,
  sourceId: string,
  opts: { maxDepth?: number; threshold?: number } = {},
): Impact[] {
  const maxDepth = opts.maxDepth ?? 4;
  const threshold = opts.threshold ?? 0.05;
  const best = new Map<string, { score: number; via: string }>();
  // DFS accumulating multiplicative weight along outgoing edges.
  const walk = (id: string, score: number, depth: number, via: string) => {
    if (depth > maxDepth) return;
    for (const edge of index.out.get(id) ?? []) {
      const next = index.byId.get(edge.targetId);
      if (!next) continue;
      const nextScore = score * edge.weight;
      if (nextScore < threshold) continue;
      const existing = best.get(next.id);
      if (!existing || nextScore > existing.score) {
        best.set(next.id, { score: nextScore, via: edge.relation });
        walk(next.id, nextScore, depth + 1, edge.relation);
      }
    }
  };
  walk(sourceId, 1, 1, 'root');
  best.delete(sourceId);
  return [...best.entries()]
    .map(([id, v]) => ({ entity: index.byId.get(id)!, score: round(v.score), via: v.via }))
    .sort((a, b) => b.score - a.score);
}

/** Degree centrality — the most connected entities are the household's "hubs". */
export function hubs(index: GraphIndex, limit = 5): Array<{ entity: GraphEntity; degree: number }> {
  return [...index.byId.values()]
    .map((entity) => ({
      entity,
      degree: (index.out.get(entity.id)?.length ?? 0) + (index.in.get(entity.id)?.length ?? 0),
    }))
    .filter((x) => x.degree > 0)
    .sort((a, b) => b.degree - a.degree)
    .slice(0, limit);
}

/** Entities in the graph that have no edges — data worth linking up. */
export function orphans(index: GraphIndex): GraphEntity[] {
  return [...index.byId.values()].filter(
    (e) => !(index.out.get(e.id)?.length) && !(index.in.get(e.id)?.length),
  );
}

/**
 * BUS-FACTOR / single-point-of-failure detection. A person is the SOLE connector
 * to a "thing" when they are the *only* person linked to it — so if they are
 * unavailable, that responsibility has no backup. This is deliberately distinct
 * from `hubs` (raw degree = how much coordination flows through a node): a hub
 * measures LOAD, this measures FRAGILITY (no redundancy). Things with zero people
 * linked are "unowned" (a coverage gap, not a bus-factor risk) and are skipped;
 * things with ≥2 people already have a backup and are skipped. Returns each person
 * who solely holds ≥ `minDependents` things, most-loaded first (ties by name), with
 * their dependents sorted by name for stable, testable output.
 */
export type SoleDependency = { person: GraphEntity; dependents: GraphEntity[] };

export function soleDependencies(index: GraphIndex, opts: { minDependents?: number } = {}): SoleDependency[] {
  const minDependents = opts.minDependents ?? 1;
  const byPerson = new Map<string, GraphEntity[]>();
  for (const entity of index.byId.values()) {
    if (entity.kind === 'person') continue;
    // Unique person-neighbours of this thing (both edge directions, de-duped).
    const persons = new Map<string, GraphEntity>();
    for (const n of neighbours(index, entity.id)) {
      if (n.entity.kind === 'person') persons.set(n.entity.id, n.entity);
    }
    if (persons.size !== 1) continue; // 0 = unowned; ≥2 = already has a backup
    const [only] = persons.values();
    (byPerson.get(only.id) ?? byPerson.set(only.id, []).get(only.id)!).push(entity);
  }
  const out: SoleDependency[] = [];
  for (const [pid, dependents] of byPerson) {
    if (dependents.length < minDependents) continue;
    dependents.sort((a, b) => a.name.localeCompare(b.name));
    out.push({ person: index.byId.get(pid)!, dependents });
  }
  return out.sort((a, b) => b.dependents.length - a.dependents.length || a.person.name.localeCompare(b.person.name));
}

/** A one-line, human-readable rendering of a path ("Emma → plays → Soccer → at → Field"). */
export function describePath(index: GraphIndex, path: GraphEntity[]): string {
  if (path.length === 0) return '';
  const parts: string[] = [path[0].name];
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i].id, b = path[i + 1].id;
    const edge =
      (index.out.get(a) ?? []).find((e) => e.targetId === b) ??
      (index.in.get(a) ?? []).find((e) => e.sourceId === b);
    parts.push(edge ? `—${edge.relation}→` : '—');
    parts.push(path[i + 1].name);
  }
  return parts.join(' ');
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export const EMPTY_GRAPH: Graph = { entities: [], edges: [] };
