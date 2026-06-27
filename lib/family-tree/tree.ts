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

  function setGen(node: TreeNode, gen: number) {
    node.generation = gen;
    for (const c of node.children) setGen(c, gen + 1);
  }
  for (const r of roots) setGen(r, 0);

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
