// lib/marketing/personalization.ts — pure engine for the Personalization pillar.
// Evaluates audience-match constraints against a visitor context and resolves the
// best content variant for a slot. No server-only imports (unit-testable); the
// server wrapper reads rules and calls resolveSlot().

/** Audience constraints. A rule matches when EVERY present constraint holds. */
export type AudienceMatch = {
  source?: string[];      // utm_source ∈ list
  medium?: string[];      // utm_medium ∈ list
  campaign?: string[];    // utm_campaign ∈ list
  returning?: boolean;    // visitor is/ isn't returning
  segments?: string[];    // ctx.segments intersects list
  minSessions?: number;   // ctx.sessions ≥ n
  paths?: string[];       // ctx.path startsWith any
  countries?: string[];   // ctx.country ∈ list
};

export type VisitorContext = {
  source?: string | null;
  medium?: string | null;
  campaign?: string | null;
  returning?: boolean;
  segments?: string[];
  sessions?: number;
  path?: string | null;
  country?: string | null;
};

export type PersonalizationVariant = {
  headline?: string;
  subhead?: string;
  body?: string;
  cta_label?: string;
  cta_href?: string;
  [key: string]: unknown;
};

export type PersonalizationRule = {
  id: string;
  slot: string;
  match: AudienceMatch;
  variant: PersonalizationVariant;
  priority: number;
  status: string;
  created_at?: string;
  deleted_at?: string | null;
};

const lc = (v: string | null | undefined) => (v ?? '').trim().toLowerCase();
function inList(value: string | null | undefined, list?: string[]): boolean {
  if (!list || list.length === 0) return true; // unconstrained
  const v = lc(value);
  return !!v && list.some((x) => lc(x) === v);
}

/** Does the visitor context satisfy every constraint in `match`? */
export function ruleMatches(match: AudienceMatch | null | undefined, ctx: VisitorContext): boolean {
  const m = match ?? {};
  if (!inList(ctx.source, m.source)) return false;
  if (!inList(ctx.medium, m.medium)) return false;
  if (!inList(ctx.campaign, m.campaign)) return false;
  if (!inList(ctx.country, m.countries)) return false;
  if (typeof m.returning === 'boolean' && m.returning !== (ctx.returning ?? false)) return false;
  if (typeof m.minSessions === 'number' && m.minSessions > 0 && (ctx.sessions ?? 0) < m.minSessions) return false;
  if (m.segments && m.segments.length > 0) {
    const have = new Set((ctx.segments ?? []).map(lc));
    if (!m.segments.some((s) => have.has(lc(s)))) return false;
  }
  if (m.paths && m.paths.length > 0) {
    const p = lc(ctx.path);
    if (!m.paths.some((x) => p.startsWith(lc(x)))) return false;
  }
  return true;
}

/** Count of active constraints — used to break priority ties (more specific wins). */
export function matchSpecificity(match: AudienceMatch | null | undefined): number {
  const m = match ?? {};
  let n = 0;
  for (const k of ['source', 'medium', 'campaign', 'segments', 'paths', 'countries'] as const) {
    if (m[k] && (m[k] as string[]).length > 0) n++;
  }
  if (typeof m.returning === 'boolean') n++;
  if (typeof m.minSessions === 'number' && m.minSessions > 0) n++;
  return n;
}

/** Pick the best rule for a slot given a visitor context: active + matching,
 *  ordered by priority desc, then specificity desc, then oldest first. */
export function resolveSlot(
  rules: PersonalizationRule[],
  slot: string,
  ctx: VisitorContext,
): PersonalizationRule | null {
  const candidates = rules.filter(
    (r) => r.slot === slot && r.status === 'active' && !r.deleted_at && ruleMatches(r.match, ctx),
  );
  candidates.sort((a, b) =>
    b.priority - a.priority ||
    matchSpecificity(b.match) - matchSpecificity(a.match) ||
    (a.created_at ?? '').localeCompare(b.created_at ?? ''),
  );
  return candidates[0] ?? null;
}

/** Convenience: resolve a slot to its variant (or null if nothing matches). */
export function resolveVariant(
  rules: PersonalizationRule[],
  slot: string,
  ctx: VisitorContext,
): PersonalizationVariant | null {
  return resolveSlot(rules, slot, ctx)?.variant ?? null;
}
