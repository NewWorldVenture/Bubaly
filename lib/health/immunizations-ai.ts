export type ImmunizationsInsights = {
  totalRecords: number;
  overdueCount: number;
  dueSoonCount: number;
  vaccineCounts: Record<string, number>;
  summary: string;
};

export interface ImmunizationEntryLike {
  vaccine: string;
  dose_label: string | null;
  date_given: string | null;
  next_due_date: string | null;
}

export function analyzeImmunizations(records: readonly ImmunizationEntryLike[]): ImmunizationsInsights {
  const vaccineCounts: Record<string, number> = {};
  let overdueCount = 0;
  let dueSoonCount = 0;
  const now = new Date();
  const soonThreshold = new Date();
  soonThreshold.setDate(soonThreshold.getDate() + 30);

  for (const r of records) {
    vaccineCounts[r.vaccine] = (vaccineCounts[r.vaccine] ?? 0) + 1;
    if (r.next_due_date) {
      const due = new Date(r.next_due_date);
      if (due < now) overdueCount++;
      else if (due <= soonThreshold) dueSoonCount++;
    }
  }

  const parts: string[] = [];
  parts.push(`${records.length} record${records.length === 1 ? '' : 's'}`);
  parts.push(`${Object.keys(vaccineCounts).length} vaccines`);
  if (overdueCount > 0) parts.push(`${overdueCount} overdue`);
  if (dueSoonCount > 0) parts.push(`${dueSoonCount} due soon`);

  return { totalRecords: records.length, overdueCount, dueSoonCount, vaccineCounts, summary: parts.join(' · ') };
}

export function buildImmunizationsPrompt(records: readonly ImmunizationEntryLike[]): { system: string; user: string } {
  const system = `You are the Bubaly family immunization tracker. Analyze the family's vaccination records and suggest follow-up actions. Return STRUCTURED JSON only — no markdown, no code fences, no commentary.

Use exactly this shape:
{
  "suggestions": ["specific, actionable immunization suggestion"],
  "scheduleTips": ["tip for staying on schedule with vaccinations"],
  "reminderTip": "one short tip for managing vaccine reminders"
}

Rules:
- suggestions: max 4 practical suggestions based on current records
- scheduleTips: max 3 tips for keeping up with the vaccination schedule
- reminderTip: one concrete recommendation
- Focus on overdue doses, upcoming boosters, and keeping records organized for school/travel.`;

  const recordList = records.map((r) =>
    `${r.vaccine}${r.dose_label ? ` (${r.dose_label})` : ''} — given: ${r.date_given ?? 'unknown'}${r.next_due_date ? `, next due: ${r.next_due_date}` : ''}`
  ).join('\n');
  const user = `The family has ${records.length} immunization records:\n\n${recordList}\n\nReturn the JSON now.`;
  return { system, user };
}

export type ImmunizationsAIResponse = {
  suggestions: string[];
  scheduleTips: string[];
  reminderTip: string;
};

export function parseImmunizationsResponse(raw: string): ImmunizationsAIResponse {
  const empty: ImmunizationsAIResponse = { suggestions: [], scheduleTips: [], reminderTip: '' };
  if (!raw || typeof raw !== 'string') return empty;

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4)
        : [],
      scheduleTips: Array.isArray(parsed.scheduleTips)
        ? parsed.scheduleTips.filter((s): s is string => typeof s === 'string').slice(0, 3)
        : [],
      reminderTip: typeof parsed.reminderTip === 'string' ? parsed.reminderTip : '',
    };
  } catch {
    return empty;
  }
}
