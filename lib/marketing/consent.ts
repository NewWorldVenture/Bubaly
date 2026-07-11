// lib/marketing/consent.ts — privacy-first visitor consent.
//
// The resolver is PURE (unit-tested): given the append-only consent events for a
// visitor, it computes the current per-category state (latest decision wins),
// honoring GPC/Do-Not-Sell for categories the visitor hasn't explicitly chosen.
// Server helpers record and read events via the service client.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

type DB = SupabaseClient<Database>;

export const CONSENT_CATEGORIES = [
  'necessary', 'analytics', 'personalization', 'marketing_email', 'marketing_sms',
] as const;
export type ConsentCategory = (typeof CONSENT_CATEGORIES)[number];
export type ConsentDecision = 'granted' | 'denied';
export type ConsentEvent = { category: ConsentCategory; decision: ConsentDecision; created_at: string };
export type ConsentState = Record<ConsentCategory, boolean>;

export const CONSENT_POLICY_VERSION = 'v1';

// Categories that a browser GPC / Do-Not-Sell signal switches off by default
// (until the visitor makes an explicit choice for that category).
const GPC_GOVERNED: ConsentCategory[] = ['analytics', 'personalization', 'marketing_email', 'marketing_sms'];

/**
 * Default policy when a visitor has made no explicit choice:
 *   necessary       — always on (not revocable; strictly required to run the site)
 *   analytics       — first-party legitimate interest, ON until denied or GPC
 *   personalization — OFF (opt-in)
 *   marketing_*     — OFF (opt-in; never messaged without explicit consent)
 */
export const DEFAULT_CONSENT: ConsentState = {
  necessary: true,
  analytics: true,
  personalization: false,
  marketing_email: false,
  marketing_sms: false,
};

/**
 * Resolve the current consent state from the visitor's event history. Latest
 * decision per category wins; GPC forces the governed categories off ONLY where
 * the visitor hasn't explicitly decided (an explicit later choice is respected).
 * `necessary` is always true.
 */
export function resolveConsent(events: ConsentEvent[], opts: { gpc?: boolean } = {}): ConsentState {
  const latest = new Map<ConsentCategory, ConsentDecision>();
  const ordered = [...events].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
  for (const e of ordered) latest.set(e.category, e.decision);

  const state: ConsentState = { ...DEFAULT_CONSENT };
  for (const category of CONSENT_CATEGORIES) {
    const decided = latest.get(category);
    if (decided) {
      state[category] = decided === 'granted';
    } else if (opts.gpc && GPC_GOVERNED.includes(category)) {
      state[category] = false;
    }
  }
  state.necessary = true; // never off
  return state;
}

export const canRecordAnalytics = (s: ConsentState): boolean => s.analytics;
export const canPersonalize = (s: ConsentState): boolean => s.personalization;
export const canMarketEmail = (s: ConsentState): boolean => s.marketing_email;
export const canMarketSms = (s: ConsentState): boolean => s.marketing_sms;

/** Normalize an arbitrary category string to a known one, or null. */
export function toConsentCategory(v: unknown): ConsentCategory | null {
  return typeof v === 'string' && (CONSENT_CATEGORIES as readonly string[]).includes(v)
    ? (v as ConsentCategory)
    : null;
}

// ── Server helpers ──────────────────────────────────────────────────────────

/** Append consent decisions for a visitor. One immutable row per category. */
export async function recordConsentEvents(supabase: DB, params: {
  anonymousId: string;
  decisions: Partial<Record<ConsentCategory, ConsentDecision>>;
  source?: string | null;
  gpc?: boolean;
  contactId?: string | null;
  userAgent?: string | null;
  policyVersion?: string;
}): Promise<void> {
  const rows = (Object.entries(params.decisions) as [ConsentCategory, ConsentDecision][])
    .filter(([category]) => (CONSENT_CATEGORIES as readonly string[]).includes(category))
    // `necessary` is not revocable — never persist a denial for it.
    .filter(([category, decision]) => !(category === 'necessary' && decision === 'denied'))
    .map(([category, decision]) => ({
      anonymous_id: params.anonymousId,
      contact_id: params.contactId ?? null,
      category,
      decision,
      policy_version: params.policyVersion ?? CONSENT_POLICY_VERSION,
      source: params.source ?? 'api',
      gpc: params.gpc ?? false,
      user_agent: params.userAgent ?? null,
    }));
  if (rows.length === 0) return;
  await supabase.from('mkt_consent_events').insert(rows);
}

/** Read a visitor's current consent state (latest per category + GPC). */
export async function getConsentState(
  supabase: DB, anonymousId: string, opts: { gpc?: boolean } = {},
): Promise<ConsentState> {
  const { data } = await supabase
    .from('mkt_consent_events')
    .select('category, decision, created_at')
    .eq('anonymous_id', anonymousId)
    .order('created_at', { ascending: true })
    .limit(500);
  const events = (data ?? []).map((r) => ({
    category: r.category as ConsentCategory,
    decision: r.decision as ConsentDecision,
    created_at: r.created_at,
  }));
  return resolveConsent(events, opts);
}
