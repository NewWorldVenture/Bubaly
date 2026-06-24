export type FamilyTreeInsights = {
  totalNodes: number;
  generationCount: number;
  relationshipCounts: Record<string, number>;
  summary: string;
};

export interface TreeNodeForAI {
  name: string;
  relationship: string;
  birth_year: number | null;
  death_year: number | null;
  birth_place: string | null;
}

export function analyzeFamilyTree(nodes: readonly TreeNodeForAI[]): FamilyTreeInsights {
  const relationshipCounts: Record<string, number> = {};
  const generations = new Set<string>();

  for (const n of nodes) {
    relationshipCounts[n.relationship] = (relationshipCounts[n.relationship] ?? 0) + 1;
    if (n.birth_year != null) {
      const decade = `${Math.floor(n.birth_year / 10) * 10}s`;
      generations.add(decade);
    }
  }

  const parts: string[] = [];
  parts.push(`${nodes.length} member${nodes.length === 1 ? '' : 's'}`);
  parts.push(`${Object.keys(relationshipCounts).length} relationship types`);
  if (generations.size > 0) parts.push(`${generations.size} generations`);

  return { totalNodes: nodes.length, generationCount: generations.size, relationshipCounts, summary: parts.join(' · ') };
}

export function buildFamilyTreePrompt(nodes: readonly TreeNodeForAI[]): { system: string; user: string } {
  const system = `You are the Bubaly family heritage advisor. Analyze the family tree and suggest ways to preserve and explore family history. Return STRUCTURED JSON only — no markdown, no code fences, no commentary.

Use exactly this shape:
{
  "suggestions": ["specific, actionable family history suggestion"],
  "heritageTips": ["tip for preserving or exploring family heritage"],
  "storytellingTip": "one short tip for capturing family stories"
}

Rules:
- suggestions: max 4 practical suggestions based on the tree
- heritageTips: max 3 tips for heritage preservation
- storytellingTip: one concrete recommendation
- Focus on filling gaps in the tree, recording stories, and connecting with living relatives.`;

  const nodeList = nodes.map((n) =>
    `${n.name} (${n.relationship}${n.birth_year ? `, born ${n.birth_year}` : ''}${n.death_year ? `, died ${n.death_year}` : ''}${n.birth_place ? `, ${n.birth_place}` : ''})`
  ).join('\n');
  const user = `The family tree has ${nodes.length} members:\n\n${nodeList}\n\nReturn the JSON now.`;
  return { system, user };
}

export type FamilyTreeAIResponse = {
  suggestions: string[];
  heritageTips: string[];
  storytellingTip: string;
};

export function parseFamilyTreeResponse(raw: string): FamilyTreeAIResponse {
  const empty: FamilyTreeAIResponse = { suggestions: [], heritageTips: [], storytellingTip: '' };
  if (!raw || typeof raw !== 'string') return empty;

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4)
        : [],
      heritageTips: Array.isArray(parsed.heritageTips)
        ? parsed.heritageTips.filter((s): s is string => typeof s === 'string').slice(0, 3)
        : [],
      storytellingTip: typeof parsed.storytellingTip === 'string' ? parsed.storytellingTip : '',
    };
  } catch {
    return empty;
  }
}
