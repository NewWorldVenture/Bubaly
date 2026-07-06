import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

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
  let existingId: string | null = null;
  if (email) {
    const { data } = await admin.from('crm_contacts').select('id').ilike('email', email).limit(1);
    existingId = data?.[0]?.id ?? null;
  }
  if (!existingId && p.familyId) {
    const { data } = await admin.from('crm_contacts').select('id').eq('family_id', p.familyId).limit(1);
    existingId = data?.[0]?.id ?? null;
  }

  if (existingId) {
    await admin.from('crm_contacts').update(row).eq('id', existingId);
  } else {
    await admin.from('crm_contacts').insert({ ...row, created_by: p.userId });
  }
}
