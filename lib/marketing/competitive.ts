// lib/marketing/competitive.ts — pure helpers for competitive intelligence.

/** Normalizes a domain: strips scheme, www, path, and lowercases. */
export function normalizeDomain(input: string | null | undefined): string {
  let s = (input ?? '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '');
  s = s.split('/')[0].split('?')[0].split('#')[0];
  return s;
}

export type BacklinkStatus = 'active' | 'lost' | 'toxic';
export const BACKLINK_STATUSES: BacklinkStatus[] = ['active', 'lost', 'toxic'];
export function isBacklinkStatus(s: string): s is BacklinkStatus {
  return (BACKLINK_STATUSES as string[]).includes(s);
}

/** Clamp a 0–100 score (difficulty/authority); null passes through. */
export function clampScore(n: number | null | undefined): number | null {
  if (n == null || Number.isNaN(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export interface KeywordLike { search_volume: number; our_rank: number | null }

/**
 * An "opportunity score" for a keyword: high volume + poor/absent ranking =
 * bigger opportunity. Unranked (null) is treated as rank 100. Score 0–100.
 */
export function keywordOpportunity(k: KeywordLike): number {
  const rank = k.our_rank == null ? 100 : Math.max(1, k.our_rank);
  const volumeWeight = Math.min(1, (k.search_volume || 0) / 10_000); // saturate at 10k
  const rankWeight = Math.min(1, rank / 100);
  return Math.round(volumeWeight * rankWeight * 100);
}

/** Top keyword opportunities, highest first. */
export function rankKeywordOpportunities<T extends KeywordLike>(keywords: T[]): T[] {
  return [...keywords].sort((a, b) => keywordOpportunity(b) - keywordOpportunity(a));
}

export interface BacklinkLike { status: BacklinkStatus; authority: number | null }

export interface BacklinkSummary {
  active: number; lost: number; toxic: number; avgAuthority: number;
}

/** Aggregates backlinks for the dashboard cards. */
export function summarizeBacklinks(links: BacklinkLike[]): BacklinkSummary {
  let active = 0, lost = 0, toxic = 0, authSum = 0, authCount = 0;
  for (const l of links) {
    if (l.status === 'active') active += 1;
    else if (l.status === 'lost') lost += 1;
    else if (l.status === 'toxic') toxic += 1;
    if (l.authority != null) { authSum += l.authority; authCount += 1; }
  }
  return { active, lost, toxic, avgAuthority: authCount === 0 ? 0 : Math.round(authSum / authCount) };
}
