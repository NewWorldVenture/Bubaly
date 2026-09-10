/** X6: recorded positive outcomes / all recorded decisions. This measures
 * acceptance, including automatic execution, rather than proven satisfaction. */
export const SIGNAL_SOURCES = ['family_signals', 'autopilot'] as const;
export type SignalSource = (typeof SIGNAL_SOURCES)[number];
export type SignalOutcomeCount = { accepted: number; dismissed: number; decided: number; precision: number | null };
export type SignalPrecision = SignalOutcomeCount & { bySource: Record<SignalSource, SignalOutcomeCount> };
export type SignalOutcome = { kind: SignalSource; status: string; count?: number };

const ACCEPTED = new Set(['acknowledged', 'approved', 'executed', 'auto_executed']);

function totals(accepted: number, dismissed: number): SignalOutcomeCount {
  const decided = accepted + dismissed;
  return { accepted, dismissed, decided, precision: decided === 0 ? null : accepted / decided };
}

/** `count` accepts exact database counts without downloading a capped sample.
 * Open, active, snoozed and unknown states carry no recorded decision. */
export function signalPrecision(rows: readonly SignalOutcome[]): SignalPrecision {
  const counts = { family_signals: { accepted: 0, dismissed: 0 }, autopilot: { accepted: 0, dismissed: 0 } };
  for (const row of rows) {
    const count = row.count ?? 1;
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid signal outcome count');
    if (ACCEPTED.has(row.status)) counts[row.kind].accepted += count;
    else if (row.status === 'dismissed') counts[row.kind].dismissed += count;
  }
  const bySource = {
    family_signals: totals(counts.family_signals.accepted, counts.family_signals.dismissed),
    autopilot: totals(counts.autopilot.accepted, counts.autopilot.dismissed),
  };
  return {
    ...totals(bySource.family_signals.accepted + bySource.autopilot.accepted, bySource.family_signals.dismissed + bySource.autopilot.dismissed),
    bySource,
  };
}
