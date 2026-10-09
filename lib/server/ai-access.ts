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
/** The assistant page + `/api/ai`. A different product, at a different tier, from the concierge. */
export const AI_ASSISTANT_FEATURE_KEY = 'ai-assistant';

/**
 * Monthly AI requests per plan level (0 Free / 1 Basic / 2 Plus).
 * `null` means unlimited.
 *
 * The numbers are not a choice made here — they are read off the plans the site
 * sells in `lib/constants/plans.ts`: Free lists **"10 AI requests/month"** and
 * Basic lists **"Unlimited AI assistant & concierge"**. This constant sat at
 * `{0: null, 1: null, 2: null}` with a comment saying numbers would land "when
 * the plans define them" — and the plans had defined them, so Free was sold a
 * meter that did not exist.
 *
 * "AI requests" is the whole-product budget the copy names, so the count below
 * is every `ai_requests` row the family filed this month whatever its kind — an
 * assistant turn, a concierge request, a briefing. It used to filter
 * `kind = 'concierge'`, which counted none of the assistant's turns: the
 * assistant records its turns with the default kind `'feature'` (see
 * `withAiRequest`), so a meter that only counted concierge rows would have read
 * zero however much a family used Bubaly.
 */
export const AI_MONTHLY_ALLOWANCE: Readonly<Record<0 | 1 | 2, number | null>> = { 0: 10, 1: null, 2: null };

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

// `count_family_ai_requests_month` arrives with held migration 0493. Until a
// database has it, the allowance is counted as the previous release counted it:
// a direct `ai_requests` count under the caller's RLS. Recognised only from the
// exact missing-function answer that names this function (PGRST202 from the
// schema cache, 42883 from Postgres), so a permission, network or internal
// error from an RPC that exists keeps failing closed. PGRST202 comes from
// PostgREST's schema cache, so applying 0493 must be followed by a cache reload
// (`NOTIFY pgrst, 'reload schema'`): until then this fallback keeps counting
// directly, and under 0493's private-read RLS that count misses private rows.
const MONTHLY_COUNT_RPC = 'count_family_ai_requests_month';
const MONTHLY_COUNT_MIGRATION = 'supabase/reserved/0493_ai_copy_private_read_and_quota.sql';
let warnedMissingMonthlyCount = false;

function isMissingMonthlyCountRpc(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, message, details, hint } = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
  if (code !== 'PGRST202' && code !== '42883') return false;
  const names = new RegExp(`(?:^|[^A-Za-z0-9_.]|(?<![A-Za-z0-9_])public\\.)${MONTHLY_COUNT_RPC}(?![A-Za-z0-9_])`);
  return [message, details, hint].some((text) => typeof text === 'string' && names.test(text));
}

function warnMissingMonthlyCountRpc(): void {
  if (warnedMissingMonthlyCount) return;
  warnedMissingMonthlyCount = true;
  console.warn(
    `[ai-access] function public.${MONTHLY_COUNT_RPC} is missing: migration ${MONTHLY_COUNT_MIGRATION} has not been applied to this database. Counting this month's AI requests directly from ai_requests, as before. If 0493 has been applied, reload PostgREST's schema cache (NOTIFY pgrst, 'reload schema').`,
  );
}

/** Test seam: forget that the missing-RPC warning was printed. */
export function resetMonthlyCountFallbackWarning(): void {
  warnedMissingMonthlyCount = false;
}

/**
 * May this caller file a concierge request right now?
 *
 * `db` is the caller's RLS-bound client. A protected count-only RPC includes
 * all household usage while private request rows stay hidden; on a database
 * without that RPC (held 0493) the count is the previous direct read. Super-admins bypass the
 * tier the same way `requireFeature` lets them preview an `off` feature.
 */
export async function assertAIAccess(
  ctx: UserContext,
  opts: { db: DB; now?: Date; featureKey?: string; label?: string },
): Promise<AIAccess> {
  const familyId = ctx.active.familyId;
  // Which product is being asked for. The concierge ('ai-requests') and the
  // assistant ('ai-assistant') are separate catalog entries at separate tiers,
  // and gating both on the concierge's entry is how the assistant came to be
  // refused to families whose plan includes it.
  const featureKey = opts.featureKey ?? AI_REQUESTS_FEATURE_KEY;
  // What the refusal below calls the thing being refused. It comes from the
  // catalog entry for `featureKey`, because the catalog is already where a
  // feature's name lives and it is what the plan and pricing surfaces render —
  // so an upgrade prompt names the feature the way the reader will find it in
  // the list they are being sent to. Deriving it also means a caller that gates
  // on a featureKey cannot label itself as a DIFFERENT product by forgetting to
  // pass a label, which is the shape of the bug that had the assistant gated on
  // the concierge's entry. 'ai-requests' is itself labelled 'Ask Bubaly', so the
  // ten callers that pass neither argument read exactly as they did.
  const label = opts.label ?? FEATURE_CATALOG_BY_KEY[featureKey]?.label ?? 'Ask Bubaly';

  const superAdmin = isSuperAdminEmail(ctx.user.email);
  let tiers: Record<string, string>;
  try {
    tiers = await getResolvedFeatureTiers(opts.db, { onUnavailable: 'throw' });
  } catch (error) {
    // An unreadable tier map is not the published offer: an admin can make a
    // feature stricter than its catalog default (free → Plus, or Off), and the
    // default would open what the admin closed. Answer as for an unreadable
    // plan. A super administrator passes every tier, so for them the tier does
    // not decide anything and the catalog default stands in.
    console.error('[ai-access] feature tier read failed', error);
    if (!superAdmin) {
      return { ok: false, status: 403, code: 'unavailable', error: 'Bubaly could not confirm your plan right now. Try again in a moment.' };
    }
    tiers = {};
  }
  const tier = (tiers[featureKey] ?? FEATURE_CATALOG_BY_KEY[featureKey]?.defaultTier ?? 'basic') as 'off' | 'free' | 'basic' | 'plus';

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
      error: need >= 2 ? `${label} is part of Family+. Upgrade to let Bubaly plan and act for your family.` : `${label} is part of Family Basic. Upgrade to let Bubaly plan and act for your family.`,
    };
  }

  const level = (planLevel >= 2 ? 2 : planLevel >= 1 ? 1 : 0) as 0 | 1 | 2;
  const allowance = superAdmin ? null : AI_MONTHLY_ALLOWANCE[level];
  if (allowance === null) return { ok: true, planLevel, monthlyUsed: null, monthlyAllowance: null };

  let count: unknown;
  let countError: unknown;
  const now = opts.now ?? new Date();
  try {
    const result = await opts.db.rpc('count_family_ai_requests_month', {
      p_family_id: familyId,
      p_month_start: monthStartIso(now),
    });
    count = result.data;
    countError = result.error;
    if (isMissingMonthlyCountRpc(countError)) {
      // Held migration 0493 is not on this database yet: count the way the
      // previous release did. Only that exact missing-function answer lands
      // here; every other RPC failure still fails closed below.
      warnMissingMonthlyCountRpc();
      const legacy = await opts.db
        .from('ai_requests')
        .select('id', { count: 'exact', head: true })
        .eq('family_id', familyId)
        .gte('created_at', monthStartIso(now));
      // No `?? 0`: a head count with no error and no count (supabase-js leaves
      // `count` null when Content-Range does not come back) is an unread
      // count, not an empty month. It fails closed below, as a null RPC
      // receipt does.
      count = legacy.error ? null : legacy.count;
      countError = legacy.error;
    }
  } catch (error) {
    countError = error;
  }
  if (countError || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
    // Fail closed: an allowance that cannot be checked is not an allowance.
    console.error('[ai-access] monthly usage read failed', countError ?? { error: 'invalid count receipt' });
    return { ok: false, status: 403, code: 'unavailable', error: 'Bubaly could not check this month\'s usage. Try again in a moment.' };
  }
  const used = count;
  if (used >= allowance) {
    return {
      ok: false, status: 429, code: 'allowance_exceeded',
      error: `Your family has used its ${allowance} AI requests for this month. Upgrade to Family Basic for unlimited, or try again next month.`,
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
