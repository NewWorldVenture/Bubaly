export type BinderInsights = {
  totalEntries: number;
  categoryCounts: Record<string, number>;
  missingCategories: string[];
  sensitiveCount: number;
  summary: string;
};

export interface BinderEntryLike {
  category: string;
  label: string;
  is_sensitive: boolean;
}

const ESSENTIAL_CATEGORIES = ['wifi', 'emergency', 'shutoff', 'insurance'];

export function analyzeBinder(entries: readonly BinderEntryLike[]): BinderInsights {
  const categoryCounts: Record<string, number> = {};
  let sensitiveCount = 0;

  for (const e of entries) {
    categoryCounts[e.category] = (categoryCounts[e.category] ?? 0) + 1;
    if (e.is_sensitive) sensitiveCount++;
  }

  const missingCategories = ESSENTIAL_CATEGORIES.filter((c) => !categoryCounts[c]);

  const parts: string[] = [];
  parts.push(`${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`);
  parts.push(`${Object.keys(categoryCounts).length} categor${Object.keys(categoryCounts).length === 1 ? 'y' : 'ies'}`);
  if (sensitiveCount > 0) parts.push(`${sensitiveCount} sensitive`);
  if (missingCategories.length > 0) parts.push(`${missingCategories.length} essential missing`);

  return { totalEntries: entries.length, categoryCounts, missingCategories, sensitiveCount, summary: parts.join(' · ') };
}

export function buildBinderPrompt(entries: readonly BinderEntryLike[]): { system: string; user: string } {
  const system = `You are the Bubaly household binder assistant. Analyze the family's household information entries and suggest improvements for completeness. Return STRUCTURED JSON only — no markdown, no code fences, no commentary.

Use exactly this shape:
{
  "suggestions": ["specific, actionable suggestion for household binder completeness"],
  "missingEntries": ["important household info entry the family should add"],
  "organizationTip": "one short tip for better binder organization"
}

Rules:
- suggestions: max 4 practical suggestions based on what's present and missing
- missingEntries: max 4 entries most households need (e.g. "water shutoff location", "circuit breaker map", "pet vet contact")
- organizationTip: one concrete tip
- Never reference specific values since they may be sensitive. Only suggest organizational improvements.`;

  const summary = entries.map((e) => `[${e.category}] ${e.label}${e.is_sensitive ? ' (sensitive)' : ''}`).join('\n');
  const user = `The household binder has ${entries.length} entries:\n\n${summary}\n\nReturn the JSON now.`;
  return { system, user };
}

export type BinderAIResponse = {
  suggestions: string[];
  missingEntries: string[];
  organizationTip: string;
};

export function parseBinderResponse(raw: string): BinderAIResponse {
  const empty: BinderAIResponse = { suggestions: [], missingEntries: [], organizationTip: '' };
  if (!raw || typeof raw !== 'string') return empty;

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4)
        : [],
      missingEntries: Array.isArray(parsed.missingEntries)
        ? parsed.missingEntries.filter((s): s is string => typeof s === 'string').slice(0, 4)
        : [],
      organizationTip: typeof parsed.organizationTip === 'string' ? parsed.organizationTip : '',
    };
  } catch {
    return empty;
  }
}
