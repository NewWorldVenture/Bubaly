'use server';

import type { SupabaseClient } from '@supabase/supabase-js';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import type { Database } from '@/lib/database.types';
import {
  normalizeAnswer, type ProfileField, type KnownProfile,
} from '@/lib/marketing/progressive-profile';
import { escapeLike } from '@/lib/supabase/escape-like';

type Admin = SupabaseClient<Database>;

export type ProfileState = { known: KnownProfile; skipped: string[] };

const FIELDS: ProfileField[] = ['role', 'top_priority', 'household_size', 'child_ages', 'interests'];

/** Log a read or write that did not come back, and the Error the action rejects with. */
function unanswered(what: string, detail: Record<string, unknown>): Error {
  console.error(`[profile-actions] ${what}`, detail);
  return new Error(`Profile ${what}`);
}

/**
 * Resolve (or create) the durable crm_contacts lead for the signed-in user.
 *
 * Only a returned list may say "no such contact". Both lookups used to bind
 * `data` alone, and PostgREST RESOLVES a timeout or 5xx as `{ data: null, error }`
 * (an empty-bodied 404 as neither), so a failed read fell through to the INSERT
 * and crm_contacts — no unique key on email — took a second contact for the same
 * person. That duplicate is then a row the sign-in stitch's email lookup can
 * pick (lib/marketing/identity.ts), and a contact id that is not the one on this
 * device's visitor row reads as a stranger's 'fork'. Same rule as identity.ts
 * and onboarding-contact.ts: a lookup that did not answer stops here and the
 * action rejects. On a rejected save or skip the nudge keeps the question on
 * screen (components/marketing/profile-nudge.tsx); the null this used to return
 * reached it as an empty profile instead, resetting everything it showed.
 */
async function resolveContactId(admin: Admin, userId: string, email: string | null): Promise<string> {
  const { data: owned, error: ownedError } = await admin.from('crm_contacts').select('id').eq('owner_id', userId).limit(1);
  if (ownedError || !Array.isArray(owned)) throw unanswered('contact lookup by owner failed', { error: ownedError ?? 'no result list' });
  if (owned[0]?.id) return owned[0].id;

  const e = (email ?? '').trim().toLowerCase();
  if (e) {
    const { data: byEmail, error: byEmailError } = await admin.from('crm_contacts').select('id, owner_id').ilike('email', escapeLike(e)).limit(1);
    if (byEmailError || !Array.isArray(byEmail)) throw unanswered('contact lookup by email failed', { error: byEmailError ?? 'no result list' });
    if (byEmail[0]?.id) {
      if (byEmail[0].owner_id == null) {
        // The contact IS this person's either way; an unclaimed owner_id only
        // means the next call finds it by email again and retries the claim.
        const { error: claimError } = await admin.from('crm_contacts').update({ owner_id: userId }).eq('id', byEmail[0].id);
        if (claimError) console.error('[profile-actions] contact owner claim failed', { contactId: byEmail[0].id, error: claimError });
      }
      return byEmail[0].id;
    }
  }
  const { data: created, error: createError } = await admin.from('crm_contacts').insert({
    email: e || null, owner_id: userId, lead_source: 'app', lead_status: 'customer', lifecycle_stage: 'customer',
  } as never).select('id').single();
  if (createError || !created) throw unanswered('contact create failed', { error: createError ?? 'no row returned' });
  return created.id;
}

async function loadState(admin: Admin, contactId: string): Promise<ProfileState> {
  // `.limit(1)` returns an ARRAY, so "no profile yet" is `[]` and cannot be
  // confused with an empty-bodied 404, which postgrest-js resolves as
  // data=null AND error=null — the shape `.maybeSingle()` would have read as
  // "no profile". identity.ts reads its visitor row the same way for the same
  // reason.
  const { data: rows, error } = await admin.from('crm_contact_profile').select('*').eq('contact_id', contactId).limit(1);
  // A failed read is not "nothing answered yet": skipProfileFieldAction writes
  // `extra.skipped` built from this state, so an empty stand-in would overwrite
  // every question the person already dismissed.
  if (error || !Array.isArray(rows)) throw unanswered('profile read failed', { contactId, error });
  const data = rows[0];
  if (!data) return { known: {}, skipped: [] };
  const extra = (data.extra && typeof data.extra === 'object' ? data.extra : {}) as { skipped?: unknown };
  return {
    known: {
      role: data.role, top_priority: data.top_priority, household_size: data.household_size,
      child_ages: data.child_ages, interests: data.interests ?? [],
    },
    skipped: Array.isArray(extra.skipped) ? extra.skipped.map(String) : [],
  };
}

/** Hydrate the progressive-profiling card: what's known + what's been skipped. */
export async function getProfileStateAction(): Promise<ProfileState> {
  const ctx = await requireUserContext();
  const admin = createServiceClient();
  const contactId = await resolveContactId(admin, ctx.user.id, ctx.user.email);
  return loadState(admin, contactId);
}

/** Save one progressive-profiling answer, then return the fresh state. */
export async function saveProfileAnswerAction(field: string, rawValue: unknown): Promise<ProfileState> {
  const ctx = await requireUserContext();
  if (!FIELDS.includes(field as ProfileField)) return getProfileStateAction();
  const value = normalizeAnswer(field as ProfileField, rawValue);
  if (value === null) return getProfileStateAction();

  const admin = createServiceClient();
  const contactId = await resolveContactId(admin, ctx.user.id, ctx.user.email);

  const { error: saveError } = await admin.from('crm_contact_profile').upsert(
    { contact_id: contactId, [field]: value } as never,
    { onConflict: 'contact_id' },
  );
  if (saveError) throw unanswered('answer save failed', { contactId, field, error: saveError });
  return loadState(admin, contactId);
}

/** Dismiss one question so it isn't re-asked (recorded in extra.skipped). */
export async function skipProfileFieldAction(field: string): Promise<ProfileState> {
  const ctx = await requireUserContext();
  if (!FIELDS.includes(field as ProfileField)) return getProfileStateAction();

  const admin = createServiceClient();
  const contactId = await resolveContactId(admin, ctx.user.id, ctx.user.email);

  const state = await loadState(admin, contactId);
  const skipped = [...new Set([...state.skipped, field])];
  const { error: skipError } = await admin.from('crm_contact_profile').upsert(
    { contact_id: contactId, extra: { skipped } } as never,
    { onConflict: 'contact_id' },
  );
  // The returned state says the question is dismissed; only a write that landed may say so.
  if (skipError) throw unanswered('skip save failed', { contactId, field, error: skipError });
  return { ...state, skipped };
}
