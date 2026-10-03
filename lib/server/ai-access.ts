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
import { AI_MONTHLY_ALLOWANCE } from '@/lib/constants/ai-allowance';
import { createServer } from '@/lib/supabase/server';
import { getUserContext, type UserContext } from '@/lib/supabase/auth';
import { extractBearerToken, getBearerUserContext } from '@/lib/supabase/bearer';
import { getTranslations } from '@/lib/i18n/server';

type DB = SupabaseClient<Database>;
/** A request's translator — `getTranslations()` or `getAIRequestTranslations(req)`. */
type Translator = (key: string, params?: Record<string, string | number>) => string;

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
 * is every METERED `ai_requests` row the family filed this month whatever its
 * kind — an assistant turn, a concierge request, a briefing. Work the family
 * did not ask for is filed with `metered = false` (0477) and is not counted.
 * It used to filter
 * `kind = 'concierge'`, which counted none of the assistant's turns: the
 * assistant records its turns with the default kind `'feature'` (see
 * `withAiRequest`), so a meter that only counted concierge rows would have read
 * zero however much a family used Bubaly.
 */
export { AI_MONTHLY_ALLOWANCE };

export type AIAccessDenial = {
  ok: false;
  /** HTTP status the caller should answer with: 404 when the feature is off (never confirm it exists), 403 for plan, 429 for allowance. */
  status: 403 | 404 | 429;
  code: 'feature_off' | 'plan_required' | 'allowance_exceeded' | 'unavailable';
  error: string;
  /** Plan level the feature needs, for the upgrade link. */
  needLevel?: number;
  /** The monthly cap that was reached (`allowance_exceeded` only), so a client can format its own copy. */
  limit?: number;
  /** The catalog name of the feature refused (`plan_required`, `feature_off`), for `denialMessage`. */
  feature?: string;
  /** What could not be read (`unavailable` only): the plan, or this month's usage. */
  unreadable?: 'plan' | 'usage';
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

  let tiers: Record<string, string>;
  try {
    tiers = await getResolvedFeatureTiers(opts.db);
  } catch (error) {
    // A settings outage must not open the gate: the catalog default is the
    // documented offer, so fall back to it explicitly rather than to "allow".
    console.error('[ai-access] feature tier read failed; using catalog defaults', error);
    tiers = { [featureKey]: FEATURE_CATALOG_BY_KEY[featureKey]?.defaultTier ?? 'basic' };
  }
  const tier = (tiers[featureKey] ?? FEATURE_CATALOG_BY_KEY[featureKey]?.defaultTier ?? 'basic') as 'off' | 'free' | 'basic' | 'plus';
  const superAdmin = isSuperAdminEmail(ctx.user.email);

  if (tier === 'off' && !superAdmin) {
    return { ok: false, status: 404, code: 'feature_off', feature: label, error: 'Not found.' };
  }

  let planLevel: number;
  try {
    planLevel = superAdmin ? 2 : await resolveFamilyPlanLevel(opts.db, familyId);
  } catch (error) {
    console.error('[ai-access] plan level read failed', error);
    return { ok: false, status: 403, code: 'unavailable', unreadable: 'plan', error: 'Bubaly could not confirm your plan right now. Try again in a moment.' };
  }
  const need = tier === 'off' ? 0 : tierToLevel(tier);
  if (planLevel < need) {
    return {
      ok: false, status: 403, code: 'plan_required', needLevel: need, feature: label,
      error: need >= 2 ? `${label} is part of Family+. Upgrade to let Bubaly plan and act for your family.` : `${label} is part of Family Basic. Upgrade to let Bubaly plan and act for your family.`,
    };
  }

  return monthlyAllowance(ctx.active.familyId, opts, planLevel, superAdmin);
}

async function monthlyAllowance(
  familyId: string,
  opts: { db: DB; now?: Date },
  planLevel: number,
  superAdmin: boolean,
): Promise<AIAccess> {
  const level = (planLevel >= 2 ? 2 : planLevel >= 1 ? 1 : 0) as 0 | 1 | 2;
  const allowance = superAdmin ? null : AI_MONTHLY_ALLOWANCE[level];
  if (allowance === null) return { ok: true, planLevel, monthlyUsed: null, monthlyAllowance: null };

  const { count, error } = await opts.db
    .from('ai_requests')
    .select('id', { count: 'exact', head: true })
    .eq('family_id', familyId)
    // Only what the family is charged for (0477): exempt work — chore-proof
    // validation, system-scope intake, scheduled routines — is filed with
    // `metered = false` and never uses up the allowance.
    .eq('metered', true)
    .gte('created_at', monthStartIso(opts.now ?? new Date()));
  if (error) {
    // Fail closed: an allowance that cannot be checked is not an allowance.
    console.error('[ai-access] monthly usage read failed', error);
    return { ok: false, status: 403, code: 'unavailable', unreadable: 'usage', error: 'Bubaly could not check this month\'s usage. Try again in a moment.' };
  }
  // A response with no error and no count is not a count of zero: it is a
  // meter that did not answer. Reading it as zero let a family that had spent
  // its month call the model again. Refused the same way as a failed read.
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) {
    console.error('[ai-access] monthly usage read returned no count', { count });
    return { ok: false, status: 403, code: 'unavailable', unreadable: 'usage', error: 'Bubaly could not check this month\'s usage. Try again in a moment.' };
  }
  const used = count;
  if (used >= allowance) {
    // `error` stays the English source text, for logs and callers without a
    // translator. What a reader sees goes through `denialMessage(denial, t)`,
    // which keys off `limit`.
    return {
      ok: false, status: 429, code: 'allowance_exceeded', limit: allowance,
      error: `Your family has used its ${allowance} AI requests for this month. Upgrade to Family Basic for unlimited, or try again next month.`,
    };
  }
  return { ok: true, planLevel, monthlyUsed: used, monthlyAllowance: allowance };
}

/**
 * The monthly AI allowance alone, for a route whose FEATURE is already decided
 * by `refuseUnlessEntitled` or is Free (F19).
 *
 * The allowance is the whole-product budget the plans sell — Free lists
 * "10 AI requests/month", Basic and Plus "Unlimited" — and the count is every
 * `ai_requests` row the family filed this month, which `withAiRequest` writes
 * for every one of these routes. But only the routes that called
 * `assertAIAccess` refused past it, so a Free family could call the meal
 * planner, the chef, the journal and twenty more without end, each a paid
 * model request. This is the same check without the concierge's tier gate
 * (`assertAIAccess` would refuse a Free family a Free feature), so it changes
 * nothing for a Basic or Plus family, whose allowance is unlimited.
 */
export async function assertAIAllowance(ctx: UserContext, opts: { db: DB; now?: Date }): Promise<AIAccess> {
  const superAdmin = isSuperAdminEmail(ctx.user.email);
  let planLevel: number;
  try {
    planLevel = superAdmin ? 2 : await resolveFamilyPlanLevel(opts.db, ctx.active.familyId);
  } catch (error) {
    console.error('[ai-access] plan level read failed', error);
    return { ok: false, status: 403, code: 'unavailable', unreadable: 'plan', error: 'Bubaly could not confirm your plan right now. Try again in a moment.' };
  }
  return monthlyAllowance(ctx.active.familyId, opts, planLevel, superAdmin);
}

/**
 * For a route that has an answer without AI (a deterministic fallback): past
 * the allowance it should give that answer, not a refusal. Throw this inside
 * the try that already falls back when the model fails; the model is never
 * called, so the request is not counted either.
 */
export class AIAllowanceSpent extends Error {
  constructor() { super('The family has used this month\'s AI allowance.'); this.name = 'AIAllowanceSpent'; }
}

/** True while the family may still spend an AI request this month. */
export async function withinAIAllowance(ctx: UserContext, db: DB): Promise<boolean> {
  return (await assertAIAllowance(ctx, { db })).ok;
}

/**
 * The allowance of a family with no signed-in member on the request — the
 * public gift page, where a relative writes a message for a family's link.
 * `db` must be able to count that family's rows (the service client there).
 */
export async function assertFamilyAIAllowance(db: DB, familyId: string): Promise<AIAccess> {
  let planLevel: number;
  try {
    planLevel = await resolveFamilyPlanLevel(db, familyId);
  } catch (error) {
    console.error('[ai-access] plan level read failed', error);
    return { ok: false, status: 403, code: 'unavailable', unreadable: 'plan', error: 'Bubaly could not confirm the plan right now. Try again in a moment.' };
  }
  return monthlyAllowance(familyId, { db }, planLevel, false);
}

/**
 * The route form of `assertAIAllowance`: `null` to proceed, or the response to return.
 *
 * The refusal is written in the reader's language. A route that already holds
 * a request translator passes it (the bearer routes do: `getAIRequestTranslations`
 * honours the native app's Accept-Language over the edge's geo guess);
 * otherwise the cookie/geo/Accept-Language translator for this request is used.
 */
export async function refuseOverAIAllowance(ctx: UserContext, db: DB, t?: Translator): Promise<NextResponse | null> {
  const allowance = await assertAIAllowance(ctx, { db });
  if (allowance.ok) return null;
  return accessDeniedResponse(allowance, allowance.code === 'allowance_exceeded' ? (t ?? await getTranslations()) : undefined);
}

/**
 * JSON body for a denial, with the status the denial names.
 *
 * With a translator, the monthly allowance refusal is rendered in the reader's
 * language (status 429 and code `allowance_exceeded` unchanged); without one,
 * or for any other code, `denial.error` is sent as it is.
 */
/**
 * A refusal from `assertAIAccess` (or one built in its shape) in the reader's
 * language. Every denial carries its English source text in `error`, which is
 * what a page or server action used to show as is, so a German family read
 * "Ask Bubaly is part of Family Basic" in English. The codes and the fields
 * beside them (`limit`, `needLevel`, `feature`, `unreadable`) are enough to
 * say it in any catalogue. A denial this does not recognise keeps `error`.
 * `feature_off` stays a bare "Not found." — the gate never confirms that a
 * switched-off feature exists.
 */
export function denialMessage(denial: AIAccessDenial, t: Translator): string {
  switch (denial.code) {
    case 'allowance_exceeded':
      return denial.limit !== undefined ? t('ai.yourFamilyUsedItsMonthlyAllowance', { limit: denial.limit }) : denial.error;
    case 'plan_required':
      if (!denial.feature) return denial.error;
      return t((denial.needLevel ?? 0) >= 2 ? 'ai.featureIsPartOfFamilyPlus' : 'ai.featureIsPartOfFamilyBasic', { feature: denial.feature });
    case 'unavailable':
      if (denial.unreadable === 'plan') return t('ai.couldNotConfirmYourPlan');
      if (denial.unreadable === 'usage') return t('ai.couldNotCheckThisMonthsUsage');
      return denial.error;
    case 'feature_off':
      return t('ai.notFound');
    default:
      return denial.error;
  }
}

export function accessDeniedResponse(denial: AIAccessDenial, t?: Translator): NextResponse {
  const error = t ? denialMessage(denial, t) : denial.error;
  return NextResponse.json(
    {
      error, code: denial.code,
      ...(denial.needLevel !== undefined ? { needLevel: denial.needLevel } : {}),
      ...(denial.limit !== undefined ? { limit: denial.limit } : {}),
    },
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
