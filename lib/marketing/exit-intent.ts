// lib/marketing/exit-intent.ts — pure helpers for the Exit-Intent pillar.
// Reuses the personalization audience-match engine; adds trigger normalisation
// and conversion rollups. No server-only imports (unit-testable).
import { ruleMatches, type AudienceMatch, type VisitorContext } from '@/lib/marketing/personalization';

export type ExitTriggerMode = 'mouseleave' | 'scroll';
export type ExitTrigger = { mode: ExitTriggerMode; delayMs: number; scrollPercent: number };

/** Coerce stored trigger config into a safe, bounded shape. */
export function normalizeTrigger(raw: unknown): ExitTrigger {
  const t = (raw ?? {}) as Record<string, unknown>;
  const mode: ExitTriggerMode = t.mode === 'scroll' ? 'scroll' : 'mouseleave';
  const delayMs = typeof t.delayMs === 'number' && t.delayMs >= 0 ? Math.min(Math.round(t.delayMs), 120_000) : 0;
  const scrollPercent = typeof t.scrollPercent === 'number'
    ? Math.min(Math.max(Math.round(t.scrollPercent), 0), 100)
    : 60;
  return { mode, delayMs, scrollPercent };
}

export type ExitOfferLike = {
  status: string;
  deleted_at?: string | null;
  priority: number;
  match: AudienceMatch;
  created_at?: string;
};

/** Best active, matching offer for a visitor: priority desc, then oldest first. */
export function resolveExitIntent<T extends ExitOfferLike>(offers: T[], ctx: VisitorContext): T | null {
  const candidates = offers.filter(
    (o) => o.status === 'active' && !o.deleted_at && ruleMatches(o.match, ctx),
  );
  candidates.sort((a, b) => b.priority - a.priority || (a.created_at ?? '').localeCompare(b.created_at ?? ''));
  return candidates[0] ?? null;
}

export function conversionRate(conversions: number, impressions: number): number {
  if (!impressions || impressions <= 0) return 0;
  return Math.round((conversions / impressions) * 100);
}

export function summarizeExitIntent(rows: Array<{ impressions?: number; conversions?: number; status: string }>) {
  let impressions = 0;
  let conversions = 0;
  let active = 0;
  for (const r of rows) {
    impressions += r.impressions ?? 0;
    conversions += r.conversions ?? 0;
    if (r.status === 'active') active++;
  }
  return { offers: rows.length, active, impressions, conversions, conversionRate: conversionRate(conversions, impressions) };
}
