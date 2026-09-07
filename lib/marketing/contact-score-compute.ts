import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { scoreContact, type ContactSignals } from './contact-score';
import { PROFILE_QUESTIONS, isAnswered, type KnownProfile } from './progressive-profile';

type Admin = SupabaseClient<Database>;

const DAY = 86_400_000;

/** Gather the visitor-intelligence signals for one contact (best-effort per source). */
export async function gatherContactSignals(
  admin: Admin,
  contact: { id: string; email: string | null; lifecycle_stage: string },
  now: Date = new Date(),
): Promise<ContactSignals> {
  const email = (contact.email ?? '').trim().toLowerCase();

  // Visitor spine + touchpoint conversions (a contact may own several anon spines).
  let identified = false, sessionCount = 0, daysSinceLastSeen: number | null = null, conversions = 0;
  try {
    const { data: visitors } = await admin
      .from('mkt_visitors').select('id, session_count, last_seen').eq('contact_id', contact.id);
    if (visitors && visitors.length) {
      identified = true;
      sessionCount = visitors.reduce((s, v) => s + (v.session_count ?? 0), 0);
      const lastSeen = visitors
        .map((v) => (v.last_seen ? new Date(v.last_seen).getTime() : 0))
        .reduce((a, b) => Math.max(a, b), 0);
      if (lastSeen > 0) daysSinceLastSeen = Math.max(0, Math.floor((now.getTime() - lastSeen) / DAY));

      const ids = visitors.map((v) => v.id);
      const { count } = await admin
        .from('mkt_touchpoints').select('*', { count: 'exact', head: true })
        .in('visitor_id', ids).eq('kind', 'conversion');
      conversions = count ?? 0;
    }
  } catch { /* marketing tables not present → leave defaults */ }

  // Consent (explicit marketing opt-in / analytics) — latest decision per category.
  let marketingConsent = false, analyticsConsent = false;
  try {
    const { data: events } = await admin
      .from('mkt_consent_events').select('category, decision, created_at')
      .eq('contact_id', contact.id).order('created_at', { ascending: true });
    const latest = new Map<string, string>();
    for (const e of events ?? []) latest.set(e.category, e.decision);
    analyticsConsent = latest.get('analytics') === 'granted';
    marketingConsent = latest.get('marketing_email') === 'granted' || latest.get('marketing_sms') === 'granted';
  } catch { /* consent table absent */ }

  // Progressive-profile completeness.
  let profileCompleteness = 0;
  try {
    const { data: p } = await admin
      .from('crm_contact_profile').select('role, top_priority, household_size, child_ages, interests')
      .eq('contact_id', contact.id).maybeSingle();
    if (p) {
      const known = p as unknown as KnownProfile;
      const answered = PROFILE_QUESTIONS.filter((q) => isAnswered(known[q.field])).length;
      profileCompleteness = answered / PROFILE_QUESTIONS.length;
    }
  } catch { /* profile table absent */ }

  return {
    hasEmail: !!email,
    identified,
    sessionCount,
    daysSinceLastSeen,
    conversions,
    marketingConsent,
    analyticsConsent,
    profileCompleteness,
    isCustomer: contact.lifecycle_stage === 'customer',
  };
}

/** Recompute + persist one contact's score. Returns the score (or null if it couldn't). */
export async function recomputeContactScore(admin: Admin, contactId: string): Promise<number | null> {
  const { data: contact, error: contactError } = await admin
    .from('crm_contacts').select('id, email, lifecycle_stage').eq('id', contactId).maybeSingle();
  if (contactError) throw contactError;
  if (!contact) return null;

  const signals = await gatherContactSignals(admin, contact);
  const result = scoreContact(signals);
  const { error } = await admin.from('crm_lead_scores').upsert(
    { contact_id: contactId, score: result.score, band: result.band, factors: result.factors as never, computed_at: new Date().toISOString() },
    { onConflict: 'contact_id' },
  );
  if (error) throw error;
  return result.score;
}

/** Recompute a batch (most-recent contacts first). Returns how many were scored. */
export async function recomputeAllContactScores(admin: Admin, limit = 1000): Promise<number> {
  const { data: contacts, error: contactsError } = await admin
    .from('crm_contacts').select('id, email, lifecycle_stage')
    .order('created_at', { ascending: false }).limit(limit);
  if (contactsError) throw contactsError;
  let n = 0;
  for (const c of contacts ?? []) {
    const signals = await gatherContactSignals(admin, c);
    const result = scoreContact(signals);
    const { error } = await admin.from('crm_lead_scores').upsert(
      { contact_id: c.id, score: result.score, band: result.band, factors: result.factors as never, computed_at: new Date().toISOString() },
      { onConflict: 'contact_id' },
    );
    if (error) throw error;
    n++;
  }
  return n;
}
