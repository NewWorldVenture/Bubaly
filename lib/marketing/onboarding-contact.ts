import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { escapeLike } from '@/lib/supabase/escape-like';
import { wroteNoRows } from '@/lib/supabase/errors';

type DB = SupabaseClient<Database>;

/**
 * Feed the marketing engine from onboarding: create — or enrich, on re-run — a
 * `crm_contacts` row for a newly onboarded account holder, so segments,
 * campaigns and automations can target them.
 *
 * Deduped by email (case-insensitive) first, then by family, so re-running
 * onboarding (or an admin who already added the contact) enriches the SAME
 * record instead of duplicating. Best-effort by contract — callers wrap this in
 * try/catch and never block the user-facing response on it. Pass the
 * service-role client (RLS on crm_contacts is admin-only).
 */
export async function upsertOnboardingContact(admin: DB, p: {
  userId: string;
  email: string | null;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  familyId?: string | null;
  /** e.g. 'onboarding' | 'profile_onboarding'. Defaults to 'onboarding'. */
  source?: string | null;
  /** Marketing attributes (role, goals, referral source, household size, …). */
  attributes?: Record<string, unknown>;
}): Promise<void> {
  const email = p.email?.trim().toLowerCase() || null;

  // Keep the flexible marketing attributes as JSON in notes (crm_contacts has no
  // metadata column) — role, goals, referral source, household makeup, etc.
  const attrs: Record<string, unknown> = { onboarding_user_id: p.userId, ...(p.attributes ?? {}) };

  const row = {
    first_name: p.firstName?.trim() || null,
    last_name: p.lastName?.trim() || null,
    email,
    phone: p.phone?.trim() || null,
    family_id: p.familyId ?? null,
    lead_source: p.source ?? 'onboarding',
    lead_status: 'customer',
    lifecycle_stage: 'customer',
    notes: JSON.stringify(attrs),
  };

  // Dedupe: an existing contact with the same email, else one already tied to
  // this family. `.limit(1)` (not maybeSingle) so a duplicate never throws.
  //
  // The pattern is ESCAPED. This runs as the service role against a table whose
  // RLS is admin-only, and the match decides which row the update below
  // overwrites — so an unescaped `%` here matched an arbitrary stranger's
  // contact and rewrote it with this caller's name, email and family.
  let existingId: string | null = null;
  if (email) {
    const { data } = await admin.from('crm_contacts').select('id').ilike('email', escapeLike(email)).limit(1);
    existingId = data?.[0]?.id ?? null;
  }
  if (!existingId && p.familyId) {
    const { data } = await admin.from('crm_contacts').select('id').eq('family_id', p.familyId).limit(1);
    existingId = data?.[0]?.id ?? null;
  }

  // Both results are read. This function decides who a CRM contact IS — the
  // same row the identity fix was about — so a write that did not land leaves
  // the record saying something other than what the caller just established,
  // with nothing to say so.
  if (existingId) {
    // "A write that did not land" includes one that matched nothing — a
    // contact deleted since the read. Audit C1-S9-67.
    const { data: updated, error } = await admin.from('crm_contacts').update(row).eq('id', existingId).select('id');
    if (error || wroteNoRows(updated)) console.error('[onboarding-contact] contact update failed', { contactId: existingId, error: error ?? 'no rows updated' });
  } else {
    const { error } = await admin.from('crm_contacts').insert({ ...row, created_by: p.userId });
    if (error) console.error('[onboarding-contact] contact insert failed', error);
  }
}
