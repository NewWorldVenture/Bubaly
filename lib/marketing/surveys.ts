// lib/marketing/surveys.ts
// Pure survey domain logic for Marketing Pillar 1 (NPS / CSAT / CES). No DB or
// network — the scoring math is unit-tested directly. Shared by the admin
// analytics pages and the public response page.

export type SurveyType = 'nps' | 'csat' | 'ces' | 'custom';

export type SurveyTypeConfig = {
  label: string;
  metric: string;
  defaultQuestion: string;
  scaleMin: number;
  scaleMax: number;
  lowLabel: string;
  highLabel: string;
  description: string;
};

export const SURVEY_TYPES: Record<SurveyType, SurveyTypeConfig> = {
  nps: {
    label: 'NPS', metric: 'Net Promoter Score',
    defaultQuestion: 'How likely are you to recommend Bubaly to a friend or colleague?',
    scaleMin: 0, scaleMax: 10, lowLabel: 'Not at all likely', highLabel: 'Extremely likely',
    description: 'Loyalty. Promoters (9–10) minus detractors (0–6), as a number from −100 to +100.',
  },
  csat: {
    label: 'CSAT', metric: 'Customer Satisfaction',
    defaultQuestion: 'How satisfied are you with Bubaly?',
    scaleMin: 1, scaleMax: 5, lowLabel: 'Very unsatisfied', highLabel: 'Very satisfied',
    description: 'Satisfaction. Percentage of respondents in the top two boxes (4–5).',
  },
  ces: {
    label: 'CES', metric: 'Customer Effort Score',
    defaultQuestion: 'How easy was it to get what you needed today?',
    scaleMin: 1, scaleMax: 7, lowLabel: 'Very difficult', highLabel: 'Very easy',
    description: 'Effort. Average rating (higher = easier).',
  },
  custom: {
    label: 'Custom', metric: 'Average rating',
    defaultQuestion: 'How would you rate your experience?',
    scaleMin: 1, scaleMax: 5, lowLabel: 'Low', highLabel: 'High',
    description: 'A custom numeric scale; reported as an average.',
  },
};

export function isSurveyType(v: unknown): v is SurveyType {
  return v === 'nps' || v === 'csat' || v === 'ces' || v === 'custom';
}

const valid = (scores: (number | null | undefined)[]): number[] =>
  scores.filter((s): s is number => typeof s === 'number' && Number.isFinite(s));

export type NpsBreakdown = {
  nps: number; promoters: number; passives: number; detractors: number; total: number;
  promoterPct: number; passivePct: number; detractorPct: number;
};

export function npsCategory(score: number): 'promoter' | 'passive' | 'detractor' {
  if (score >= 9) return 'promoter';
  if (score >= 7) return 'passive';
  return 'detractor';
}

/** Net Promoter Score: %promoters − %detractors, rounded to an integer (−100..100). */
export function computeNps(scores: (number | null | undefined)[]): NpsBreakdown {
  const s = valid(scores);
  const total = s.length;
  if (total === 0) return { nps: 0, promoters: 0, passives: 0, detractors: 0, total: 0, promoterPct: 0, passivePct: 0, detractorPct: 0 };
  let promoters = 0, passives = 0, detractors = 0;
  for (const v of s) {
    const c = npsCategory(v);
    if (c === 'promoter') promoters++; else if (c === 'passive') passives++; else detractors++;
  }
  const promoterPct = (promoters / total) * 100;
  const detractorPct = (detractors / total) * 100;
  return {
    nps: Math.round(promoterPct - detractorPct),
    promoters, passives, detractors, total,
    promoterPct: Math.round(promoterPct), passivePct: Math.round((passives / total) * 100), detractorPct: Math.round(detractorPct),
  };
}

export type CsatResult = { csat: number; average: number; total: number; topBox: number };

/** CSAT: top-two-box satisfaction as a percentage (0..100). */
export function computeCsat(scores: (number | null | undefined)[], scaleMax = 5): CsatResult {
  const s = valid(scores);
  const total = s.length;
  if (total === 0) return { csat: 0, average: 0, total: 0, topBox: 0 };
  const topBox = s.filter((v) => v >= scaleMax - 1).length; // top two values
  const average = s.reduce((a, b) => a + b, 0) / total;
  return { csat: Math.round((topBox / total) * 100), average: Math.round(average * 100) / 100, total, topBox };
}

export type CesResult = { average: number; total: number };

/** CES: simple average (higher = less effort, on an easy-scale). */
export function computeCes(scores: (number | null | undefined)[]): CesResult {
  const s = valid(scores);
  const total = s.length;
  if (total === 0) return { average: 0, total: 0 };
  return { average: Math.round((s.reduce((a, b) => a + b, 0) / total) * 100) / 100, total };
}

/** Count of each score value across the scale, for a distribution chart. */
export function distribution(scores: (number | null | undefined)[], min: number, max: number): { value: number; count: number }[] {
  const counts = new Map<number, number>();
  for (let i = min; i <= max; i++) counts.set(i, 0);
  for (const v of valid(scores)) if (counts.has(v)) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].map(([value, count]) => ({ value, count }));
}

export type SurveySummary = {
  headline: string;     // e.g. "NPS", "CSAT", "CES"
  value: string;        // formatted primary metric
  total: number;        // responses counted
  detail?: string;      // secondary line
};

/** One unified summary for any survey type, for cards/dashboards. */
export function summarize(type: SurveyType, scores: (number | null | undefined)[], scaleMax = 10): SurveySummary {
  if (type === 'nps') {
    const r = computeNps(scores);
    return { headline: 'NPS', value: String(r.nps), total: r.total, detail: `${r.promoterPct}% promoters · ${r.detractorPct}% detractors` };
  }
  if (type === 'csat') {
    const r = computeCsat(scores, scaleMax);
    return { headline: 'CSAT', value: `${r.csat}%`, total: r.total, detail: `avg ${r.average} / ${scaleMax}` };
  }
  if (type === 'ces') {
    const r = computeCes(scores);
    return { headline: 'CES', value: `${r.average}`, total: r.total, detail: `out of ${scaleMax}` };
  }
  const r = computeCes(scores);
  return { headline: 'Average', value: `${r.average}`, total: r.total, detail: `out of ${scaleMax}` };
}

/** A URL-safe short slug for a survey's public link. */
export function generateSlug(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 32) || 'survey';
  const rand = Math.random().toString(36).slice(2, 8);
  return `${base}-${rand}`;
}
