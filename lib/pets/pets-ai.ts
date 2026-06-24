export type PetsInsights = {
  totalPets: number;
  speciesCounts: Record<string, number>;
  summary: string;
};

export interface PetForAI {
  name: string;
  species: string;
  breed: string | null;
  birthday: string | null;
}

export function analyzePets(pets: PetForAI[]): PetsInsights {
  const speciesCounts: Record<string, number> = {};

  for (const p of pets) {
    speciesCounts[p.species] = (speciesCounts[p.species] ?? 0) + 1;
  }

  const summary = pets.length === 0
    ? 'No pets registered yet.'
    : `${pets.length} pets: ${Object.entries(speciesCounts).map(([s, c]) => `${c} ${s}`).join(', ')}.`;

  return { totalPets: pets.length, speciesCounts, summary };
}

export function buildPetsPrompt(pets: PetForAI[]) {
  const system = `You are a pet care advisor. Analyze pet data and return ONLY valid JSON with this shape:
{"suggestions":["..."],"careTips":["..."],"healthReminder":"..."}
suggestions: up to 4 actionable ideas. careTips: up to 3 tips. healthReminder: one sentence about pet health.`;

  const user = `Pets:\n${JSON.stringify(pets.slice(0, 30))}`;
  return { system, user };
}

export type PetsAIResponse = {
  suggestions: string[];
  careTips: string[];
  healthReminder: string;
};

export function parsePetsResponse(raw: string): PetsAIResponse {
  const empty: PetsAIResponse = { suggestions: [], careTips: [], healthReminder: '' };
  if (!raw || typeof raw !== 'string') return empty;

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4)
        : [],
      careTips: Array.isArray(parsed.careTips)
        ? parsed.careTips.filter((s): s is string => typeof s === 'string').slice(0, 3)
        : [],
      healthReminder: typeof parsed.healthReminder === 'string' ? parsed.healthReminder : '',
    };
  } catch {
    return empty;
  }
}
