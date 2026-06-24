export type SchoolInsights = {
  totalClasses: number;
  totalGrades: number;
  averageScore: number | null;
  summary: string;
};

export interface SchoolGradeForAI {
  subject: string;
  grade_type: string;
  score: number | null;
  max_score: number | null;
  date: string;
}

export function analyzeSchool(classes: number, grades: SchoolGradeForAI[]): SchoolInsights {
  const scored = grades.filter((g) => g.score != null && g.max_score != null && g.max_score > 0);
  const averageScore = scored.length > 0
    ? scored.reduce((sum, g) => sum + (g.score! / g.max_score!) * 100, 0) / scored.length
    : null;

  const summary = classes === 0 && grades.length === 0
    ? 'No school data tracked yet.'
    : `${classes} classes, ${grades.length} grades recorded.${averageScore != null ? ` Average: ${averageScore.toFixed(0)}%.` : ''}`;

  return { totalClasses: classes, totalGrades: grades.length, averageScore, summary };
}

export function buildSchoolPrompt(grades: SchoolGradeForAI[]) {
  const system = `You are a family education advisor. Analyze school grade data and return ONLY valid JSON with this shape:
{"suggestions":["..."],"studyTips":["..."],"encouragement":"..."}
suggestions: up to 4 actionable ideas. studyTips: up to 3 tips. encouragement: one motivational sentence for the student.`;

  const user = `Grades:\n${JSON.stringify(grades.slice(0, 50))}`;
  return { system, user };
}

export type SchoolAIResponse = {
  suggestions: string[];
  studyTips: string[];
  encouragement: string;
};

export function parseSchoolResponse(raw: string): SchoolAIResponse {
  const empty: SchoolAIResponse = { suggestions: [], studyTips: [], encouragement: '' };
  if (!raw || typeof raw !== 'string') return empty;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4) : [],
      studyTips: Array.isArray(parsed.studyTips) ? parsed.studyTips.filter((s): s is string => typeof s === 'string').slice(0, 3) : [],
      encouragement: typeof parsed.encouragement === 'string' ? parsed.encouragement : '',
    };
  } catch { return empty; }
}
