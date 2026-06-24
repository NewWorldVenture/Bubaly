export type MedicalRecordsInsights = {
  totalProfiles: number;
  totalProviders: number;
  summary: string;
};

export interface MedicalProfileForAI {
  blood_type: string | null;
  allergies: string | null;
  conditions: string | null;
}

export function analyzeMedicalRecords(profiles: MedicalProfileForAI[]): MedicalRecordsInsights {
  const totalProviders = 0;

  const summary = profiles.length === 0
    ? 'No medical profiles created yet.'
    : `${profiles.length} medical profiles on file.`;

  return { totalProfiles: profiles.length, totalProviders, summary };
}

export function buildMedicalRecordsPrompt(profiles: MedicalProfileForAI[]) {
  const system = `You are a family health records advisor. Analyze medical profile data and return ONLY valid JSON with this shape:
{"suggestions":["..."],"organizationTips":["..."],"preparationTip":"..."}
suggestions: up to 4 actionable ideas. organizationTips: up to 3 tips. preparationTip: one sentence about being prepared for medical visits.`;

  const user = `Medical profiles:\n${JSON.stringify(profiles.slice(0, 50))}`;
  return { system, user };
}

export type MedicalRecordsAIResponse = {
  suggestions: string[];
  organizationTips: string[];
  preparationTip: string;
};

export function parseMedicalRecordsResponse(raw: string): MedicalRecordsAIResponse {
  const empty: MedicalRecordsAIResponse = { suggestions: [], organizationTips: [], preparationTip: '' };
  if (!raw || typeof raw !== 'string') return empty;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4) : [],
      organizationTips: Array.isArray(parsed.organizationTips) ? parsed.organizationTips.filter((s): s is string => typeof s === 'string').slice(0, 3) : [],
      preparationTip: typeof parsed.preparationTip === 'string' ? parsed.preparationTip : '',
    };
  } catch { return empty; }
}
