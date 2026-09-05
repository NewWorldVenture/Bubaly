// lib/supabase/bearer.ts — Supabase access for non-browser clients (the Expo
// mobile app, scripts) that authenticate with `Authorization: Bearer <jwt>`
// instead of the cookie session the web app uses.
//
// The returned client carries the user's own JWT, so every query runs under RLS
// exactly as it would for the cookie-bound server client: the mobile app can
// never read another family's rows, and the service-role key is never involved.
import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../database.types';
import type { FamilyMembership, UserContext } from './auth';
import type { MemberRole } from '@/lib/constants/roles';

type DB = SupabaseClient<Database>;

/** Pull the token out of an `Authorization` header; null when absent/malformed. */
export function extractBearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+([A-Za-z0-9\-._~+/]+=*)$/i.exec(header.trim());
  return m ? m[1] : null;
}

/** A user-scoped client bound to the given access token (RLS as that user). */
export function createBearerClient(token: string): DB {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    },
  );
}

export type BearerContext =
  | { ok: true; supabase: DB; ctx: UserContext; user: { id: string; email: string | null } }
  | { ok: false; reason: 'invalid_token' | 'needs_family' | 'unavailable'; supabase?: DB; user?: { id: string; email: string | null } };

/**
 * Validate a bearer token and resolve the same user + active-family context the
 * web app gets from cookies. Mirrors getUserContext() but returns tagged
 * results instead of redirecting, so API routes can answer 401/403 in JSON.
 */
export async function getBearerUserContext(token: string): Promise<BearerContext> {
  const supabase = createBearerClient(token);
  const { data: auth, error: authError } = await supabase.auth.getUser(token);
  if (authError || !auth.user) return { ok: false, reason: 'invalid_token' };
  const user = { id: auth.user.id, email: auth.user.email ?? null };

  const { data: members, error: membersError } = await supabase
    .from('family_members').select('*').eq('user_id', user.id).eq('is_active', true);
  if (membersError) {
    console.error('[bearer] family membership query failed', membersError);
    return { ok: false, reason: 'unavailable', supabase, user };
  }
  const rows = members ?? [];
  if (rows.length === 0) return { ok: false, reason: 'needs_family', supabase, user };

  const familyIds = rows.map((m) => m.family_id);
  const { data: families, error: familiesError } = await supabase.from('families').select('*').in('id', familyIds);
  if (familiesError) {
    console.error('[bearer] family query failed', familiesError);
    return { ok: false, reason: 'unavailable', supabase, user };
  }
  const byId = new Map((families ?? []).map((f) => [f.id, f]));
  const memberships: FamilyMembership[] = [];
  for (const m of rows) {
    const family = byId.get(m.family_id);
    if (!family) {
      // Same fail-closed rule as the cookie path: a membership without its
      // family row is a tenant-context failure, never an onboarding state.
      console.error('[bearer] family context incomplete', { familyId: m.family_id });
      return { ok: false, reason: 'unavailable', supabase, user };
    }
    memberships.push({ familyId: m.family_id, family, role: m.role as MemberRole, member: m });
  }

  const { data: prefs, error: prefsError } = await supabase
    .from('user_preferences').select('active_family_id').eq('user_id', user.id).maybeSingle();
  if (prefsError) {
    console.error('[bearer] user preference query failed', prefsError);
    return { ok: false, reason: 'unavailable', supabase, user };
  }
  const active = memberships.find((m) => m.familyId === prefs?.active_family_id) ?? memberships[0];
  return { ok: true, supabase, user, ctx: { user, memberships, active } };
}
