// lib/marketing/attribution.ts — pure multi-touch attribution + visitor-intel
// helpers. Given a visitor's ordered touchpoints, distribute conversion credit
// across channels using the standard models. Deterministic, unit-tested.

export type AttributionModel = 'first_touch' | 'last_touch' | 'linear' | 'position_based';

export const ATTRIBUTION_MODELS: AttributionModel[] = ['first_touch', 'last_touch', 'linear', 'position_based'];
export const ATTRIBUTION_MODEL_LABELS: Record<AttributionModel, string> = {
  first_touch: 'First touch', last_touch: 'Last touch', linear: 'Linear', position_based: 'Position-based (40/20/40)',
};

export interface Touchpoint {
  visitor_id: string;
  source: string | null;
  kind: 'touch' | 'conversion';
  occurred_at: string;
}

/** A channel label for a touch; falls back to 'direct' when source is empty. */
export function channelOf(t: { source: string | null }): string {
  return (t.source ?? '').trim() || 'direct';
}

/**
 * Distributes 1.0 of conversion credit across a single visitor's ordered touches
 * per the chosen model. Touches must be for ONE visitor; order is by time.
 * Returns a map channel → credit (sums to ~1 when there is ≥1 touch).
 */
export function creditForVisitor(touches: Touchpoint[], model: AttributionModel): Record<string, number> {
  const ordered = [...touches].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  const channels = ordered.map(channelOf);
  const out: Record<string, number> = {};
  const n = channels.length;
  if (n === 0) return out;

  const add = (ch: string, v: number) => { out[ch] = (out[ch] ?? 0) + v; };

  if (model === 'first_touch') { add(channels[0], 1); return out; }
  if (model === 'last_touch') { add(channels[n - 1], 1); return out; }
  if (model === 'linear') { for (const ch of channels) add(ch, 1 / n); return out; }

  // position_based: 40% first, 40% last, 20% split across the middle.
  if (n === 1) { add(channels[0], 1); return out; }
  if (n === 2) { add(channels[0], 0.5); add(channels[1], 0.5); return out; }
  add(channels[0], 0.4);
  add(channels[n - 1], 0.4);
  const mid = 0.2 / (n - 2);
  for (let i = 1; i < n - 1; i++) add(channels[i], mid);
  return out;
}

/**
 * Aggregates attribution across many visitors. Only visitors with a conversion
 * touch contribute credit (you attribute *conversions*). Returns channels sorted
 * by descending credit.
 */
export function attributeConversions(
  touchpoints: Touchpoint[],
  model: AttributionModel,
): Array<{ channel: string; credit: number }> {
  const byVisitor = new Map<string, Touchpoint[]>();
  for (const t of touchpoints) {
    const arr = byVisitor.get(t.visitor_id) ?? [];
    arr.push(t);
    byVisitor.set(t.visitor_id, arr);
  }

  const totals: Record<string, number> = {};
  for (const touches of byVisitor.values()) {
    if (!touches.some((t) => t.kind === 'conversion')) continue; // only converting journeys
    const credit = creditForVisitor(touches, model);
    for (const [ch, v] of Object.entries(credit)) totals[ch] = (totals[ch] ?? 0) + v;
  }

  return Object.entries(totals)
    .map(([channel, credit]) => ({ channel, credit }))
    .sort((a, b) => b.credit - a.credit);
}

/** Counts conversions = number of distinct visitors with a conversion touch. */
export function conversionCount(touchpoints: Touchpoint[]): number {
  const converted = new Set<string>();
  for (const t of touchpoints) if (t.kind === 'conversion') converted.add(t.visitor_id);
  return converted.size;
}
