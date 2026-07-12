'use server';

import type { SupabaseClient } from '@supabase/supabase-js';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import type { Database } from '@/lib/database.types';
import {
  normalizeAnswer, type ProfileField, type KnownProfile,
} from '@/lib/marketing/progressive-profile';

type Admin = SupabaseClient<Database>;

export type ProfileState = { known: KnownProfile; skipped: string[] };

const FIELDS: ProfileField[] = ['role', 'top_priority', 'household_size', 'child_ages', 'interests'];

/** Resolve (or create) the durable crm_contacts lead for the signed-in user. */
async function resolveContactId(admin: Admin, userId: string, email: string | null): Promise<string | null> {
  const { data: owned } = await admin.from('crm_contacts').select('id').eq('owner_id', userId).limit(1);
  if (owned?.[0]?.id) return owned[0].id;

  const e = (email ?? '').trim().toLowerCase();
  if (e) {
    const { data: byEmail } = await admin.from('crm_contacts').select('id, owner_id').ilike('email', e).limit(1);
    if (byEmail?.[0]?.id) {
      if (byEmail[0].owner_id == null) await admin.from('crm_contacts').update({ owner_id: userId }).eq('id', byEmail[0].id);
      return byEmail[0].id;
    }
  }
  const { data: created } = await admin.from('crm_contacts').insert({
    email: e || null, owner_id: userId, lead_source: 'app', lead_status: 'customer', lifecycle_stage: 'customer',
  } as never).select('id').single();
  return created?.id ?? null;
}

async function loadState(admin: Admin, contactId: string): Promise<ProfileState> {
  const { data } = await admin.from('crm_contact_profile').select('*').eq('contact_id', contactId).maybeSingle();
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
  if (!contactId) return { known: {}, skipped: [] };
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
  if (!contactId) return { known: {}, skipped: [] };

  await admin.from('crm_contact_profile').upsert(
    { contact_id: contactId, [field]: value } as never,
    { onConflict: 'contact_id' },
  );
  return loadState(admin, contactId);
}

/** Dismiss one question so it isn't re-asked (recorded in extra.skipped). */
export async function skipProfileFieldAction(field: string): Promise<ProfileState> {
  const ctx = await requireUserContext();
  if (!FIELDS.includes(field as ProfileField)) return getProfileStateAction();

  const admin = createServiceClient();
  const contactId = await resolveContactId(admin, ctx.user.id, ctx.user.email);
  if (!contactId) return { known: {}, skipped: [] };

  const state = await loadState(admin, contactId);
  const skipped = [...new Set([...state.skipped, field])];
  await admin.from('crm_contact_profile').upsert(
    { contact_id: contactId, extra: { skipped } } as never,
    { onConflict: 'contact_id' },
  );
  return { ...state, skipped };
}
