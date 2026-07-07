// lib/experience/scorecard.ts — the Experience Scorecard model (T8, pure + tested).
//
// The premium-consistency sweep only sticks if it's *measurable*. This turns each
// surface (a module or a journey) into a dated audit across the six dimensions
// that make an experience feel premium, rolls those up into a live scorecard, and
// tracks the trend over time. DOM-free + fully unit-tested; the server persists
// audits to Supabase, this decides scores/grades/rollups.

export type DimensionKey =
  | 'empty_state'      // helpful empty states — blank never looks broken
  | 'error_recovery'   // undo / confirm-destructive / clear errors
  | 'transitions'      // predictable loading — skeletons, optimistic UI, no layout shift
  | 'performance'      // perf budget — fast first paint + interaction
  | 'accessibility'    // keyboard + screen-reader + 44px targets + labels
  | 'consistency';     // shared primitives, visual + interaction consistency

export type DimensionScores = Partial<Record<DimensionKey, number>>; // each 0..100

export type ExperienceDimension = {
  key: DimensionKey;
  label: string;
  weight: number;   // relative importance in the composite
  blurb: string;
};

/** The rubric. Weights are relative; the composite normalizes by the weights of
 *  the dimensions actually scored, so a partial audit still yields a fair score. */
export const EXPERIENCE_DIMENSIONS: ExperienceDimension[] = [
  { key: 'empty_state',    label: 'Empty state',    weight: 1.0, blurb: 'A helpful, on-brand empty state — never a broken-looking blank.' },
  { key: 'error_recovery', label: 'Error recovery', weight: 1.2, blurb: 'Undo or confirm on destructive actions; clear, recoverable errors.' },
  { key: 'transitions',    label: 'Transitions',    weight: 1.0, blurb: 'Skeletons + optimistic UI; predictable, no jarring layout shift.' },
  { key: 'performance',    label: 'Performance',    weight: 1.0, blurb: 'Meets the perf budget — fast first paint and interaction.' },
  { key: 'accessibility',  label: 'Accessibility',  weight: 1.1, blurb: 'Keyboard + screen-reader; labelled controls; 44px targets.' },
  { key: 'consistency',    label: 'Consistency',    weight: 0.9, blurb: 'Reuses shared primitives; consistent visuals and interactions.' },
];

export const DIMENSION_KEYS: DimensionKey[] = EXPERIENCE_DIMENSIONS.map((d) => d.key);
const WEIGHT = new Map(EXPERIENCE_DIMENSIONS.map((d) => [d.key, d.weight]));
const LABEL = new Map(EXPERIENCE_DIMENSIONS.map((d) => [d.key, d.label]));

const clamp = (n: number) => Math.max(0, Math.min(100, n));
const round = (n: number) => Math.round(n);

/** Weighted composite (0..100) over the dimensions actually scored. Missing
 *  dimensions are excluded (not treated as zero) so partial audits are fair. */
export function scoreAudit(dims: DimensionScores): number {
  let sum = 0;
  let weight = 0;
  for (const key of DIMENSION_KEYS) {
    const v = dims[key];
    if (typeof v !== 'number') continue;
    const w = WEIGHT.get(key)!;
    sum += clamp(v) * w;
    weight += w;
  }
  return weight ? round(sum / weight) : 0;
}

export type Grade = 'A' | 'B' | 'C' | 'D' | 'F';

/** Letter grade from a 0..100 score (standard bands). */
export function gradeFor(score: number): Grade {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

/** Below this composite, a surface is flagged as needing the sweep. */
export const NEEDS_WORK_THRESHOLD = 70;

// ── rollup ───────────────────────────────────────────────────────────────────

export type AuditRecord = {
  surfaceKey: string;
  surfaceLabel: string;
  category: string;          // 'module' | 'journey'
  auditedOn: string;         // YYYY-MM-DD
  dimensions: DimensionScores;
  score: number;             // composite (persisted, but recomputed defensively)
};

export type SurfaceSummary = {
  surfaceKey: string;
  surfaceLabel: string;
  category: string;
  latestOn: string;
  score: number;
  grade: Grade;
  delta: number | null;      // latest score − previous audit's score (null if only one)
  dimensions: DimensionScores;
  needsWork: boolean;
};

export type Scorecard = {
  surfaces: SurfaceSummary[];       // one per surface, worst score first
  overall: number;                  // avg of latest surface scores
  overallGrade: Grade;
  overallDelta: number | null;      // avg of per-surface deltas (movement since last audit)
  dimensionAverages: { key: DimensionKey; label: string; average: number; grade: Grade; count: number }[];
  weakestDimensions: DimensionKey[]; // lowest-average *measured* dimensions first
  needsWorkCount: number;           // surfaces below the threshold
  auditedSurfaces: number;
};

/** Roll dated audit rows up into a live scorecard: latest score per surface, the
 *  movement since each surface's previous audit, per-dimension averages, and the
 *  surfaces still below the premium bar. */
export function rollUpScorecard(audits: AuditRecord[]): Scorecard {
  // Group by surface, newest audit first within each group.
  const bySurface = new Map<string, AuditRecord[]>();
  for (const a of audits) {
    const arr = bySurface.get(a.surfaceKey) ?? [];
    arr.push(a);
    bySurface.set(a.surfaceKey, arr);
  }

  const surfaces: SurfaceSummary[] = [];
  for (const [key, rows] of bySurface) {
    const sorted = [...rows].sort((a, b) => b.auditedOn.localeCompare(a.auditedOn));
    const latest = sorted[0];
    const prev = sorted[1] ?? null;
    const score = scoreAudit(latest.dimensions); // recompute defensively
    surfaces.push({
      surfaceKey: key,
      surfaceLabel: latest.surfaceLabel,
      category: latest.category,
      latestOn: latest.auditedOn,
      score,
      grade: gradeFor(score),
      delta: prev ? score - scoreAudit(prev.dimensions) : null,
      dimensions: latest.dimensions,
      needsWork: score < NEEDS_WORK_THRESHOLD,
    });
  }

  // Worst first — the sweep works top-down.
  surfaces.sort((a, b) => a.score - b.score || a.surfaceLabel.localeCompare(b.surfaceLabel));

  const overall = surfaces.length ? round(surfaces.reduce((s, x) => s + x.score, 0) / surfaces.length) : 0;
  const deltas = surfaces.map((s) => s.delta).filter((d): d is number => typeof d === 'number');
  const overallDelta = deltas.length ? round(deltas.reduce((s, d) => s + d, 0) / deltas.length) : null;

  const dimensionAverages = DIMENSION_KEYS.map((key) => {
    const vals = surfaces.map((s) => s.dimensions[key]).filter((v): v is number => typeof v === 'number');
    const average = vals.length ? round(vals.reduce((s, v) => s + clamp(v), 0) / vals.length) : 0;
    return { key, label: LABEL.get(key)!, average, grade: gradeFor(average), count: vals.length };
  });

  // Only rank dimensions that were actually measured — an unaudited dimension
  // isn't "weak", it's unknown.
  const weakestDimensions = dimensionAverages
    .filter((d) => d.count > 0)
    .sort((a, b) => a.average - b.average)
    .map((d) => d.key);

  return {
    surfaces,
    overall,
    overallGrade: gradeFor(overall),
    overallDelta,
    dimensionAverages,
    weakestDimensions,
    needsWorkCount: surfaces.filter((s) => s.needsWork).length,
    auditedSurfaces: surfaces.length,
  };
}
