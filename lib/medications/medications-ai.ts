export type MedicationInsights = {
  totalMedications: number;
  totalSchedules: number;
  adherenceRate: number | null;
  missedDoses: number;
  summary: string;
};

export interface MedicationEntryLike {
  name: string;
  dosage: string | null;
  is_active: boolean;
}

export interface DoseLogSummary {
  taken: number;
  skipped: number;
  missed: number;
}

export function analyzeMedications(
  meds: readonly MedicationEntryLike[],
  scheduleCount: number,
  doseSummary: DoseLogSummary,
): MedicationInsights {
  const activeMeds = meds.filter((m) => m.is_active).length;
  const total = doseSummary.taken + doseSummary.skipped + doseSummary.missed;
  const adherenceRate = total === 0 ? null : Math.round((doseSummary.taken / total) * 100);

  const parts: string[] = [];
  parts.push(`${meds.length} medication${meds.length === 1 ? '' : 's'} (${activeMeds} active)`);
  parts.push(`${scheduleCount} schedule${scheduleCount === 1 ? '' : 's'}`);
  if (adherenceRate !== null) parts.push(`${adherenceRate}% adherence`);
  if (doseSummary.missed > 0) parts.push(`${doseSummary.missed} missed`);

  return {
    totalMedications: meds.length,
    totalSchedules: scheduleCount,
    adherenceRate,
    missedDoses: doseSummary.missed,
    summary: parts.join(' · '),
  };
}

export function buildMedicationsPrompt(
  meds: readonly MedicationEntryLike[],
  scheduleCount: number,
  doseSummary: DoseLogSummary,
): { system: string; user: string } {
  const system = `You are the Bubaly family medication assistant. Analyze the family's medication data and suggest improvements for adherence and organization. Return STRUCTURED JSON only — no markdown, no code fences, no commentary.

Use exactly this shape:
{
  "suggestions": ["specific, actionable medication management suggestion"],
  "adherenceTips": ["tip to improve medication adherence"],
  "organizationTip": "one short tip for better medication management"
}

Rules:
- suggestions: max 4 practical suggestions based on current medication setup
- adherenceTips: max 3 adherence improvement tips based on the patterns
- organizationTip: one concrete tip
- Never suggest changing dosages or stopping medications. Only suggest organizational and reminder improvements.
- Focus on adherence patterns, not medical advice.`;

  const medList = meds.map((m) => `${m.name}${m.dosage ? ` (${m.dosage})` : ''} — ${m.is_active ? 'active' : 'inactive'}`).join('\n');
  const total = doseSummary.taken + doseSummary.skipped + doseSummary.missed;
  const rate = total > 0 ? Math.round((doseSummary.taken / total) * 100) : 0;
  const user = `The family tracks ${meds.length} medications with ${scheduleCount} schedules.\nAdherence: ${rate}% (${doseSummary.taken} taken, ${doseSummary.skipped} skipped, ${doseSummary.missed} missed).\n\nMedications:\n${medList}\n\nReturn the JSON now.`;
  return { system, user };
}

export type MedicationsAIResponse = {
  suggestions: string[];
  adherenceTips: string[];
  organizationTip: string;
};

export function parseMedicationsResponse(raw: string): MedicationsAIResponse {
  const empty: MedicationsAIResponse = { suggestions: [], adherenceTips: [], organizationTip: '' };
  if (!raw || typeof raw !== 'string') return empty;

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4)
        : [],
      adherenceTips: Array.isArray(parsed.adherenceTips)
        ? parsed.adherenceTips.filter((s): s is string => typeof s === 'string').slice(0, 3)
        : [],
      organizationTip: typeof parsed.organizationTip === 'string' ? parsed.organizationTip : '',
    };
  } catch {
    return empty;
  }
}
