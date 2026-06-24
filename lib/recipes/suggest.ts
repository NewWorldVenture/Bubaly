// "What can we make tonight?" — pure prompt-building + pick parsing.
// Suggests from the family's OWN saved vault (so results are always cookable),
// optionally honoring a free-text constraint ("we have chicken & rice", "quick",
// "no dairy"). Unit tested; the route supplies the vault + calls the AI engine.

export type VaultRecipeLite = {
  id: string;
  name: string;
  cuisine?: string | null;
  category?: string | null;
  tags?: string[];
  ingredients?: { name: string }[];
};

export function buildSuggestPrompt(recipes: VaultRecipeLite[], constraint?: string): { system: string; user: string } {
  const system = [
    'You help a family decide what to cook tonight, choosing ONLY from their saved recipes.',
    'Return ONLY valid JSON (no markdown): {"picks":[{"id":"<recipe id>","reason":"<one short sentence>"}]}.',
    'Pick 3 (or fewer if the list is short). Use ONLY ids from the provided list. Order best-first.',
    'If a constraint is given, respect it (ingredients on hand, time, dietary needs).',
  ].join('\n');

  const list = recipes.map((r) => {
    const ings = (r.ingredients ?? []).slice(0, 8).map((i) => i.name).filter(Boolean).join(', ');
    const meta = [r.cuisine, r.category, (r.tags ?? []).join('/')].filter(Boolean).join(' · ');
    return `- id:${r.id} | ${r.name}${meta ? ` [${meta}]` : ''}${ings ? ` | ingredients: ${ings}` : ''}`;
  }).join('\n');

  const user = [
    constraint?.trim() ? `Constraint: ${constraint.trim()}` : 'No special constraint — suggest crowd-pleasers for a normal weeknight.',
    '',
    'Saved recipes:',
    list || '(none)',
  ].join('\n');

  return { system, user };
}

export type SuggestPick = { id: string; reason: string };

/** Parse model output, keeping only picks whose id is a real vault recipe. */
export function parseSuggestions(text: string, validIds: Iterable<string>): SuggestPick[] {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return [];
  let obj: { picks?: unknown };
  try { obj = JSON.parse(match[0]); } catch { return []; }
  const valid = new Set(validIds);
  const seen = new Set<string>();
  const picks: SuggestPick[] = [];
  for (const p of Array.isArray(obj.picks) ? obj.picks : []) {
    const o = (p ?? {}) as Record<string, unknown>;
    const id = String(o.id ?? '').trim();
    if (!id || !valid.has(id) || seen.has(id)) continue;
    seen.add(id);
    picks.push({ id, reason: String(o.reason ?? '').trim() || 'A great fit for tonight.' });
  }
  return picks;
}
