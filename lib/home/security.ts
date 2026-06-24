// lib/home/security.ts — pure helpers for Security Alerts. Severity metadata,
// open-event rollups and sorting. No Supabase/React.

export const SECURITY_KINDS = ['alarm', 'camera', 'door', 'window', 'motion', 'smoke', 'water_leak', 'alert', 'test', 'breach', 'other'] as const;
export const SECURITY_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type Severity = (typeof SECURITY_SEVERITIES)[number];

export function severityMeta(sev: string): { label: string; tone: 'neutral' | 'warning' | 'danger'; rank: number } {
  if (sev === 'critical') return { label: 'Critical', tone: 'danger', rank: 2 };
  if (sev === 'warning') return { label: 'Warning', tone: 'warning', rank: 1 };
  return { label: 'Info', tone: 'neutral', rank: 0 };
}

export type EventLike = { severity: string; resolved: boolean; occurred_at: string };

/** Open (unresolved) events newest-first; then resolved newest-first. */
export function sortEvents<T extends EventLike>(events: T[]): T[] {
  return [...events].sort((a, b) =>
    Number(a.resolved) - Number(b.resolved) || b.occurred_at.localeCompare(a.occurred_at),
  );
}

export function summarizeSecurity(events: EventLike[]) {
  let openCritical = 0, openWarning = 0, open = 0;
  for (const e of events) {
    if (e.resolved) continue;
    open++;
    if (e.severity === 'critical') openCritical++;
    else if (e.severity === 'warning') openWarning++;
  }
  return { total: events.length, open, openCritical, openWarning, allClear: open === 0 };
}
