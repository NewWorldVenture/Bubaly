// lib/server/ai-access.ts — who may ask Bubaly to do work, and how much.
//
// Two questions, answered once for every AI entry point (the request route,
// the run controls, the server actions behind the web UI):
//
//   1. WHO is calling. The web app carries a cookie session; the Expo app
//      carries `Authorization: Bearer <supabase jwt>`. `authenticateAI` resolves
//      both to the same `UserContext` and an RLS-bound client, mirroring
//      `app/api/ai/route.ts` so the two AI edges cannot drift in what they
//      accept.
//   2. WHETHER their family may use the concierge. That is the `ai-requests`
//      catalog entry (tier, overridable by the admin) plus a monthly allowance
//      seam. The allowance is `null` — unlimited — for every plan until the
//      plans define numbers, so nothing is blocked today, but the count is
//      read from `ai_requests` exactly as the future limit will be, which is
//      what lets §34 usage reporting and this gate agree.
import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { FEATURE_CATALOG_BY_KEY } from '@/lib/constants/feature-catalog';
import { isSuperAdminEmail } from '@/lib/constants/super-admins';
import { tierToLevel } from '@/lib/features/tiers';
import { getResolvedFeatureTiers } from '@/lib/server/feature-tiers';
import { ensureActiveFamily } from '@/lib/server/ensure-family';
import { resolveFamilyPlanLevel } from '@/lib/server/plan';
import { createServer } from '@/lib/supabase/server';
import { getUserContext, type UserContext } from '@/lib/supabase/auth';
import { extractBearerToken, getBearerUserContext } from '@/lib/supabase/bearer';

type DB = SupabaseClient<Database>;

export const AI_REQUESTS_FEATURE_KEY = 'ai-requests';

/**
 * Monthly concierge requests per plan level (0 Free / 1 Basic / 2 Plus).
 * `null` means unlimited. Numbers land here when the plans define them; the
 * gate, the count query and the error copy are already wired for that day.
 */
export const AI_MONTHLY_ALLOWANCE: Readonly<Record<0 | 1 | 2, number | null>> = { 0: null, 1: null, 2: null };

export type AIAccessDenial = {
  ok: false;
  /** HTTP status the caller should answer with: 404 when the feature is off (never confirm it exists), 403 for plan, 429 for allowance. */
  status: 403 | 404 | 429;
  code: 'feature_off' | 'plan_required' | 'allowance_exceeded' | 'unavailable';
  error: string;
  /** Plan level the feature needs, for the upgrade link. */
  needLevel?: number;
};

export type AIAccessGrant = {
  ok: true;
  planLevel: number;
  /** Requests filed this calendar month (family zone is not needed: allowance windows are UTC months). Null when the plan is unlimited and no count was taken. */
  monthlyUsed: number | null;
  monthlyAllowance: number | null;
};

export type AIAccess = AIAccessGrant | AIAccessDenial;

function monthStartIso(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/**
 * May this caller file a concierge request right now?
 *
 * `db` is the caller's RLS-bound client: `ai_requests` is readable by every
 * family member, so the count needs no service role. Super-admins bypass the
 * tier the same way `requireFeature` lets them preview an `off` feature.
 */
export async function assertAIAccess(
  ctx: UserContext,
  opts: { db: DB; now?: Date },
): Promise<AIAccess> {
  const familyId = ctx.active.familyId;

  let tiers: Record<string, string>;
  try {
    tiers = await getResolvedFeatureTiers(opts.db);
  } catch (error) {
    // A settings outage must not open the gate: the catalog default is the
    // documented offer, so fall back to it explicitly rather than to "allow".
    console.error('[ai-access] feature tier read failed; using catalog defaults', error);
    tiers = { [AI_REQUESTS_FEATURE_KEY]: FEATURE_CATALOG_BY_KEY[AI_REQUESTS_FEATURE_KEY]?.defaultTier ?? 'basic' };
  }
  const tier = (tiers[AI_REQUESTS_FEATURE_KEY] ?? FEATURE_CATALOG_BY_KEY[AI_REQUESTS_FEATURE_KEY]?.defaultTier ?? 'basic') as 'off' | 'free' | 'basic' | 'plus';
  const superAdmin = isSuperAdminEmail(ctx.user.email);

  if (tier === 'off' && !superAdmin) {
    return { ok: false, status: 404, code: 'feature_off', error: 'Not found.' };
  }

  let planLevel: number;
  try {
    planLevel = superAdmin ? 2 : await resolveFamilyPlanLevel(opts.db, familyId);
  } catch (error) {
    console.error('[ai-access] plan level read failed', error);
    return { ok: false, status: 403, code: 'unavailable', error: 'Bubaly could not confirm your plan right now. Try again in a moment.' };
  }
  const need = tier === 'off' ? 0 : tierToLevel(tier);
  if (planLevel < need) {
    return {
      ok: false, status: 403, code: 'plan_required', needLevel: need,
      error: need >= 2 ? 'Ask Bubaly is part of Family+. Upgrade to let Bubaly plan and act for your family.' : 'Ask Bubaly is part of Family Basic. Upgrade to let Bubaly plan and act for your family.',
    };
  }

  const level = (planLevel >= 2 ? 2 : planLevel >= 1 ? 1 : 0) as 0 | 1 | 2;
  const allowance = superAdmin ? null : AI_MONTHLY_ALLOWANCE[level];
  if (allowance === null) return { ok: true, planLevel, monthlyUsed: null, monthlyAllowance: null };

  const { count, error } = await opts.db
    .from('ai_requests')
    .select('id', { count: 'exact', head: true })
    .eq('family_id', familyId)
    .eq('kind', 'concierge')
    .gte('created_at', monthStartIso(opts.now ?? new Date()));
  if (error) {
    // Fail closed: an allowance that cannot be checked is not an allowance.
    console.error('[ai-access] monthly usage read failed', error);
    return { ok: false, status: 403, code: 'unavailable', error: 'Bubaly could not check this month\'s usage. Try again in a moment.' };
  }
  const used = count ?? 0;
  if (used >= allowance) {
    return {
      ok: false, status: 429, code: 'allowance_exceeded',
      error: `Your family has used its ${allowance} Ask Bubaly requests for this month. Upgrade for more, or try again next month.`,
    };
  }
  return { ok: true, planLevel, monthlyUsed: used, monthlyAllowance: allowance };
}

/** JSON body for a denial, with the status the denial names. */
export function accessDeniedResponse(denial: AIAccessDenial): NextResponse {
  return NextResponse.json(
    { error: denial.error, code: denial.code, ...(denial.needLevel !== undefined ? { needLevel: denial.needLevel } : {}) },
    { status: denial.status },
  );
}

// ─── Authentication ─────────────────────────────────────────────────────────

export type AuthenticatedAI = { supabase: DB; ctx: UserContext; via: 'bearer' | 'cookie' };

function unauthorized(message: string, code: string): NextResponse {
  return NextResponse.json({ error: message, code }, { status: 401 });
}

/**
 * Resolve the caller from a bearer token (mobile) or the cookie session (web).
 * A bearer header, once present, is authoritative: an invalid token is a 401,
 * never a fall-through to whatever cookies the request also carried.
 */
export async function authenticateAI(req: NextRequest): Promise<AuthenticatedAI | NextResponse> {
  const token = extractBearerToken(req.headers.get('authorization'));
  if (token) {
    const bearer = await getBearerUserContext(token);
    if (bearer.ok) return { supabase: bearer.supabase, ctx: bearer.ctx, via: 'bearer' };
    if (bearer.reason === 'invalid_token') return unauthorized('Sign in to ask Bubaly.', 'invalid_token');
    if (bearer.reason === 'needs_family') {
      return NextResponse.json({ error: 'Finish setting up your family in Bubaly first.', code: 'needs_family' }, { status: 403 });
    }
    return NextResponse.json({ error: 'Account context is temporarily unavailable.', code: 'unavailable' }, { status: 503 });
  }

  const supabase = await createServer();
  let ctx = await getUserContext();
  if (!ctx) return unauthorized('Sign in to ask Bubaly.', 'signed_out');
  if ('needsFamily' in ctx) {
    // Same auto-provisioning as requireUserContext(), minus the redirect.
    const { data: auth } = await supabase.auth.getUser();
    if (auth.user && (await ensureActiveFamily(supabase, auth.user))) ctx = await getUserContext();
    if (!ctx || 'needsFamily' in ctx) {
      return NextResponse.json({ error: 'Finish setting up your family in Bubaly first.', code: 'needs_family' }, { status: 403 });
    }
  }
  return { supabase, ctx, via: 'cookie' };
}
