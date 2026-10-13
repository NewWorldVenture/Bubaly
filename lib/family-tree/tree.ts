// lib/family-tree/tree.ts — pure family-tree logic, unit tested, no deps.
// Builds a generational hierarchy from flat node rows. Each node has an
// optional parent_node_id, a relationship label, and a linked family member.

export const RELATIONSHIPS = [
  'self', 'spouse', 'child', 'parent', 'sibling',
  'grandparent', 'grandchild', 'aunt_uncle', 'cousin',
  'niece_nephew', 'in_law', 'step_parent', 'step_child',
  'step_sibling', 'great_grandparent', 'great_grandchild', 'other',
] as const;

export type Relationship = (typeof RELATIONSHIPS)[number];

const LABELS: Record<Relationship, string> = {
  self: 'Self',
  spouse: 'Spouse',
  child: 'Child',
  parent: 'Parent',
  sibling: 'Sibling',
  grandparent: 'Grandparent',
  grandchild: 'Grandchild',
  aunt_uncle: 'Aunt / Uncle',
  cousin: 'Cousin',
  niece_nephew: 'Niece / Nephew',
  in_law: 'In-Law',
  step_parent: 'Step-Parent',
  step_child: 'Step-Child',
  step_sibling: 'Step-Sibling',
  great_grandparent: 'Great-Grandparent',
  great_grandchild: 'Great-Grandchild',
  other: 'Other',
};

export function relationshipLabel(r: string): string {
  return LABELS[r as Relationship] ?? r;
}

export type NodeLike = {
  id: string;
  parent_node_id: string | null;
  name: string;
  relationship: string;
  birth_year: number | null;
  death_year: number | null;
  member_id: string | null;
  birth_place?: string | null;
  bio?: string | null;
};

export type TreeNode = NodeLike & {
  children: TreeNode[];
  generation: number;
};

/**
 * Every person below `id` in the tree, by following parent links down. Safe on
 * a parent chain that loops (each person is visited once), and it never
 * includes `id` itself unless the loop leads back to it.
 */
export function descendantIds(nodes: Pick<NodeLike, 'id' | 'parent_node_id'>[], id: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const n of nodes) {
    if (!n.parent_node_id) continue;
    const list = children.get(n.parent_node_id) ?? [];
    list.push(n.id);
    children.set(n.parent_node_id, list);
  }
  const out = new Set<string>();
  const stack = [...(children.get(id) ?? [])];
  while (stack.length) {
    const next = stack.pop()!;
    if (out.has(next)) continue;
    out.add(next);
    stack.push(...(children.get(next) ?? []));
  }
  return out;
}

/**
 * True when making `parentId` the parent of `nodeId` would make that person
 * their own ancestor: the proposed parent is the person, or the proposed
 * parent's own chain of parents reaches the person. Walked up from the
 * proposed parent, so an existing loop elsewhere cannot make this run forever.
 */
export function wouldBeOwnAncestor(
  nodes: Pick<NodeLike, 'id' | 'parent_node_id'>[],
  nodeId: string,
  parentId: string | null | undefined,
): boolean {
  if (!parentId) return false;
  const parentOf = new Map(nodes.map((n) => [n.id, n.parent_node_id]));
  const seen = new Set<string>();
  for (let at: string | null | undefined = parentId; at; at = parentOf.get(at)) {
    if (at === nodeId) return true;
    if (seen.has(at)) return false;
    seen.add(at);
  }
  return false;
}

/**
 * The tree, as roots with their children.
 *
 * Every person appears exactly once. A person whose parent chain loops back on
 * itself (Grandma's parent set to her own grandchild) has no root above them,
 * and they used to vanish from the tree and the generations view together with
 * everything below them — the only two views that can edit or delete — while
 * the People count still counted them. Now the first person of each such loop
 * (in the order the rows came) is shown as a root, so the loop stays on screen
 * and can be repaired by editing that person.
 */
export function buildTree(nodes: NodeLike[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  for (const n of nodes) {
    byId.set(n.id, { ...n, children: [], generation: 0 });
  }

  const roots: TreeNode[] = [];
  for (const tn of byId.values()) {
    if (tn.parent_node_id && byId.has(tn.parent_node_id)) {
      byId.get(tn.parent_node_id)!.children.push(tn);
    } else {
      roots.push(tn);
    }
  }

  const placed = new Set<string>();
  function setGen(node: TreeNode, gen: number) {
    placed.add(node.id);
    node.generation = gen;
    for (const c of node.children) setGen(c, gen + 1);
  }
  for (const r of roots) setGen(r, 0);

  // Whoever is still unplaced hangs below a loop: every one of them has a
  // parent in the map, so walking up from one must revisit a person, and that
  // person is on the loop. Lift them to the top (out of their parent's
  // children, which is what breaks the loop) and place their branch.
  for (const tn of byId.values()) {
    if (placed.has(tn.id)) continue;
    const seen = new Set<string>();
    let onLoop = tn;
    while (!seen.has(onLoop.id)) {
      seen.add(onLoop.id);
      onLoop = byId.get(onLoop.parent_node_id as string)!;
    }
    const parent = byId.get(onLoop.parent_node_id as string)!;
    parent.children = parent.children.filter((c) => c !== onLoop);
    roots.push(onLoop);
    setGen(onLoop, 0);
  }

  return roots;
}

export function flattenTree(roots: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  function walk(node: TreeNode) {
    out.push(node);
    for (const c of node.children) walk(c);
  }
  for (const r of roots) walk(r);
  return out;
}

export function maxGeneration(roots: TreeNode[]): number {
  return Math.max(0, ...flattenTree(roots).map((n) => n.generation));
}

export function countByRelationship(nodes: NodeLike[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const n of nodes) m.set(n.relationship, (m.get(n.relationship) ?? 0) + 1);
  return m;
}

export type TreeStats = {
  total: number;
  generations: number;
  living: number;
  deceased: number;
};

export function treeStats(nodes: NodeLike[]): TreeStats {
  const roots = buildTree(nodes);
  return {
    total: nodes.length,
    generations: maxGeneration(roots) + 1,
    living: nodes.filter((n) => n.death_year == null).length,
    deceased: nodes.filter((n) => n.death_year != null).length,
  };
}

export function generationLabel(gen: number): string {
  const labels = ['Elders', 'Parents', 'Our Generation', 'Children', 'Grandchildren'];
  return labels[gen] ?? `Generation ${gen + 1}`;
}

export function groupByGeneration(roots: TreeNode[]): { generation: number; label: string; nodes: TreeNode[] }[] {
  const all = flattenTree(roots);
  const byGen = new Map<number, TreeNode[]>();
  for (const n of all) {
    const arr = byGen.get(n.generation) ?? [];
    arr.push(n);
    byGen.set(n.generation, arr);
  }
  return [...byGen.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([gen, nodes]) => ({ generation: gen, label: generationLabel(gen), nodes }));
}

export function lifespan(node: NodeLike): string {
  if (!node.birth_year) return '';
  if (node.death_year) return `${node.birth_year}–${node.death_year}`;
  return `b. ${node.birth_year}`;
}
