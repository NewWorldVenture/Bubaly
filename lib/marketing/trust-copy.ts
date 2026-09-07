// lib/marketing/trust-copy.ts — the public "always asks first" list, derived
// from the trust engine rather than retyped.
//
// Every public surface that says "money, health, documents and safety wait
// for a parent" renders THIS partition of HIGH_STAKES_AI_DOMAINS through the
// `trustDomains.<domain>` catalogue keys. If lib/trust/engine.ts adds or drops
// a domain, the copy follows, and tests/marketing-hero-outcomes.test.ts pins
// that the partition flattens back to exactly the engine's list.

import { HIGH_STAKES_AI_DOMAINS } from '@/lib/trust/engine';

export type HighStakesGroup = 'money' | 'health' | 'documents' | 'safety';

export const HIGH_STAKES_GROUP_ORDER: HighStakesGroup[] = ['money', 'health', 'documents', 'safety'];

/** Which heading a high-stakes domain sits under on the public site. */
const GROUP_OF: Record<string, HighStakesGroup> = {
  finances: 'money',
  banking: 'money',
  medical: 'health',
  dental: 'health',
  vision: 'health',
  mental_health: 'health',
  documents: 'documents',
  insurance: 'documents',
  passports: 'documents',
  driving: 'safety',
  emergency: 'safety',
};

/**
 * HIGH_STAKES_AI_DOMAINS partitioned into the four public headings, in the
 * engine's own order. A domain the map does not know yet is still listed —
 * under 'safety', the most conservative heading — so a new high-stakes area
 * can never be silently missing from the "asks first" copy.
 */
export function highStakesGroups(): Record<HighStakesGroup, string[]> {
  const groups: Record<HighStakesGroup, string[]> = { money: [], health: [], documents: [], safety: [] };
  for (const domain of HIGH_STAKES_AI_DOMAINS) {
    groups[GROUP_OF[domain] ?? 'safety'].push(domain);
  }
  return groups;
}

/** The catalogue key whose English equals DOMAIN_LABELS[domain]. */
export function trustDomainKey(domain: string): string {
  return `trustDomains.${domain}`;
}

/** The catalogue key for a group heading. */
export function trustGroupKey(group: HighStakesGroup): string {
  return `trustGroups.${group}`;
}
