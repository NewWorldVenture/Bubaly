export type TimetableInsights = {
  totalClasses: number;
  subjectCounts: Record<string, number>;
  busiestDay: string | null;
  memberCount: number;
  summary: string;
};

export interface TimetableClassLike {
  subject: string;
  teacher: string | null;
  room: string | null;
  time_slot: string | null;
  day_of_week: number | null;
  week_pattern: string | null;
  member_id: string;
}

const DAY_NAMES: Record<number, string> = { 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 5: 'Friday' };

export function analyzeTimetable(classes: readonly TimetableClassLike[]): TimetableInsights {
  const subjectCounts: Record<string, number> = {};
  const dayCounts: Record<number, number> = {};
  const memberIds = new Set<string>();

  for (const c of classes) {
    subjectCounts[c.subject] = (subjectCounts[c.subject] ?? 0) + 1;
    if (c.day_of_week != null) {
      dayCounts[c.day_of_week] = (dayCounts[c.day_of_week] ?? 0) + 1;
    }
    memberIds.add(c.member_id);
  }

  let busiestDay: string | null = null;
  let maxDayCount = 0;
  for (const [day, count] of Object.entries(dayCounts)) {
    if (count > maxDayCount) {
      maxDayCount = count;
      busiestDay = DAY_NAMES[Number(day)] ?? `Day ${day}`;
    }
  }

  const parts: string[] = [];
  parts.push(`${classes.length} class${classes.length === 1 ? '' : 'es'}`);
  parts.push(`${Object.keys(subjectCounts).length} subjects`);
  parts.push(`${memberIds.size} student${memberIds.size === 1 ? '' : 's'}`);
  if (busiestDay) parts.push(`busiest: ${busiestDay}`);

  return { totalClasses: classes.length, subjectCounts, busiestDay, memberCount: memberIds.size, summary: parts.join(' · ') };
}

export function buildTimetablePrompt(classes: readonly TimetableClassLike[]): { system: string; user: string } {
  const system = `You are the Bubaly family school schedule advisor. Analyze the family's class timetable and suggest study or scheduling improvements. Return STRUCTURED JSON only — no markdown, no code fences, no commentary.

Use exactly this shape:
{
  "suggestions": ["specific, actionable schedule suggestion"],
  "studyTips": ["tip for optimizing study time around this schedule"],
  "organizationTip": "one short tip for better timetable management"
}

Rules:
- suggestions: max 4 practical suggestions based on the timetable
- studyTips: max 3 tips for study habits aligned with the schedule
- organizationTip: one concrete tip
- Focus on schedule balance, study time allocation, and avoiding overload on busy days.`;

  const classList = classes.map((c) =>
    `${c.subject} (${c.day_of_week != null ? DAY_NAMES[c.day_of_week] ?? `Day ${c.day_of_week}` : 'unscheduled'}${c.time_slot ? `, ${c.time_slot}` : ''}${c.teacher ? `, ${c.teacher}` : ''}${c.room ? `, ${c.room}` : ''}${c.week_pattern && c.week_pattern !== 'all' ? `, ${c.week_pattern} week` : ''})`
  ).join('\n');
  const user = `The family has ${classes.length} scheduled classes:\n\n${classList}\n\nReturn the JSON now.`;
  return { system, user };
}

export type TimetableAIResponse = {
  suggestions: string[];
  studyTips: string[];
  organizationTip: string;
};

export function parseTimetableResponse(raw: string): TimetableAIResponse {
  const empty: TimetableAIResponse = { suggestions: [], studyTips: [], organizationTip: '' };
  if (!raw || typeof raw !== 'string') return empty;

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4)
        : [],
      studyTips: Array.isArray(parsed.studyTips)
        ? parsed.studyTips.filter((s): s is string => typeof s === 'string').slice(0, 3)
        : [],
      organizationTip: typeof parsed.organizationTip === 'string' ? parsed.organizationTip : '',
    };
  } catch {
    return empty;
  }
}
