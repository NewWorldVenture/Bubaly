// lib/operating-index/summary.ts — the evening "what changed since yesterday"
// narrative for the Family Operating Layer (pillar #5). Pure diff of today's
// Operating Index snapshot against the most recent prior one: composite delta,
// which dimensions rose/fell, and which suggestions the family cleared vs. which
// newly emerged. No Supabase, no DOM — the server passes two snapshot views in.
//
// The tone is a calm end-of-day recap, not a scoreboard: it leads with progress
// ("2 things cleared"), names what slipped without alarm, and stays silent on a
// flat day rather than manufacturing movement.

import { DIMENSION_LABELS, type DimensionId } from './score';

/** Minimal view of one day's snapshot the diff needs. */
export interface SnapshotView {
  composite: number;
  dimensions: Record<string, number>;      // {dimensionId: score}
  suggestions: { id: string; title: string }[];
}

export interface DimensionDelta {
  id: DimensionId;
  label: string;
  from: number;
  to: number;
  delta: number;
}

export interface ChangeSummary {
  /** True when there's no prior snapshot to compare against. */
  isFirst: boolean;
  headline: string;
  compositeDelta: number | null;
  improved: DimensionDelta[];   // rose by ≥ threshold, biggest first
  declined: DimensionDelta[];   // fell by ≥ threshold, biggest drop first
  resolved: { id: string; title: string }[];  // suggestions gone since yesterday
  emerged: { id: string; title: string }[];    // suggestions new since yesterday
}

// A dimension has to move by at least this much to be worth mentioning — small
// jitter (one event gaining an owner) shouldn't read as a "change".
const MOVE_THRESHOLD = 5;

function dimDeltas(current: Record<string, number>, prior: Record<string, number>): DimensionDelta[] {
  const out: DimensionDelta[] = [];
  for (const id of Object.keys(DIMENSION_LABELS) as DimensionId[]) {
    const to = current[id];
    const from = prior[id];
    if (to == null || from == null) continue;
    const delta = to - from;
    if (Math.abs(delta) >= MOVE_THRESHOLD) {
      out.push({ id, label: DIMENSION_LABELS[id], from, to, delta });
    }
  }
  return out;
}

function pluralThings(n: number): string {
  return `${n} thing${n === 1 ? '' : 's'}`;
}

/**
 * Diff two Operating Index snapshots into an evening recap. `prior` is null on
 * the family's first-ever reading. Deterministic given its inputs.
 */
export function summarizeChange(current: SnapshotView, prior: SnapshotView | null): ChangeSummary {
  if (!prior) {
    return {
      isFirst: true,
      headline: 'First reading saved — check back tomorrow to see how the day moved things.',
      compositeDelta: null,
      improved: [], declined: [], resolved: [], emerged: [],
    };
  }

  const compositeDelta = current.composite - prior.composite;
  const deltas = dimDeltas(current.dimensions, prior.dimensions);
  const improved = deltas.filter((d) => d.delta > 0).sort((a, b) => b.delta - a.delta);
  const declined = deltas.filter((d) => d.delta < 0).sort((a, b) => a.delta - b.delta);

  const priorIds = new Set(prior.suggestions.map((s) => s.id));
  const currentIds = new Set(current.suggestions.map((s) => s.id));
  const resolved = prior.suggestions.filter((s) => !currentIds.has(s.id));
  const emerged = current.suggestions.filter((s) => !priorIds.has(s.id));

  // Headline: lead with the composite move, then the most human signal
  // (cleared items beat a raw number for "how did today go?").
  const parts: string[] = [];
  if (compositeDelta > 0) parts.push(`Up ${compositeDelta} point${compositeDelta === 1 ? '' : 's'} since yesterday`);
  else if (compositeDelta < 0) parts.push(`Down ${Math.abs(compositeDelta)} point${Math.abs(compositeDelta) === 1 ? '' : 's'} since yesterday`);
  else parts.push('Holding steady since yesterday');

  if (resolved.length && emerged.length) parts.push(`${pluralThings(resolved.length)} cleared, ${emerged.length} new`);
  else if (resolved.length) parts.push(`${pluralThings(resolved.length)} cleared`);
  else if (emerged.length) parts.push(`${pluralThings(emerged.length)} came up`);
  else if (compositeDelta === 0) parts.push('nothing new needs you');

  const headline = parts.join(' — ') + '.';

  return { isFirst: false, headline, compositeDelta, improved, declined, resolved, emerged };
}
