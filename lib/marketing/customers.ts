import 'server-only';
import { settleAll } from '@/lib/supabase/settle';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { planMonthlyCents, planName } from '@/lib/constants/plans';

type DB = SupabaseClient<Database>;

export type Lifecycle = 'new' | 'active' | 'lapsed' | 'churned' | 'free';

export type MarketingCustomer = {
  familyId: string;
  name: string;
  ownerEmail: string | null;
  memberCount: number;
  plan: string;
  planLabel: string;
  status: string; // subscription status or 'free'
  lifecycle: Lifecycle;
  estLtvCents: number;
  createdAt: string;
  lastActivityAt: string;
};

const DAY = 86_400_000;

function monthsBetween(from: string, to: number): number {
  const start = new Date(from).getTime();
  if (Number.isNaN(start)) return 1;
  return Math.max(1, Math.round((to - start) / (30 * DAY)));
}

/**
 * The normalized marketing-customer view. Customers are NOT duplicated — each
 * row is derived from the existing families + subscriptions + members + profiles
 * tables, so it always reflects live data and links back to the source family.
 */
export async function getMarketingCustomersWithError(supabase: DB): Promise<{ customers: MarketingCustomer[]; error: unknown | null }> {
  const [familiesResult, subsResult, membersResult, profilesResult] = await settleAll([
    supabase.from('families').select('id, name, created_at, updated_at').order('created_at', { ascending: false }).limit(2000),
    supabase.from('subscriptions').select('family_id, plan, status, created_at, current_period_end'),
    supabase.from('family_members').select('family_id, user_id, role, is_active'),
    supabase.from('profiles').select('id, email'),
  ]);

  const error = familiesResult.error ?? subsResult.error ?? membersResult.error ?? profilesResult.error;
  if (error) return { customers: [], error };

  const { data: families } = familiesResult;
  const { data: subs } = subsResult;
  const { data: members } = membersResult;
  const { data: profiles } = profilesResult;

  const emailByUser = new Map((profiles ?? []).map((p) => [p.id, p.email]));
  const subByFamily = new Map((subs ?? []).map((s) => [s.family_id, s]));

  const membersByFamily = new Map<string, typeof members>();
  for (const m of members ?? []) {
    if (!membersByFamily.has(m.family_id)) membersByFamily.set(m.family_id, [] as never);
    membersByFamily.get(m.family_id)!.push(m);
  }

  const now = Date.now();

  const customers = (families ?? []).map((f) => {
    const fam = membersByFamily.get(f.id) ?? [];
    const active = fam.filter((m) => m.is_active);
    const owner = fam.find((m) => m.role === 'parent' && m.user_id) ?? fam.find((m) => m.user_id);
    const ownerEmail = owner?.user_id ? emailByUser.get(owner.user_id) ?? null : null;

    const sub = subByFamily.get(f.id);
    const plan = sub?.plan ?? 'free';
    const status = sub?.status ?? 'free';

    let lifecycle: Lifecycle;
    if (!sub || plan === 'free') lifecycle = 'free';
    else if (status === 'active' || status === 'trialing') {
      lifecycle = new Date(sub.created_at).getTime() > now - 30 * DAY ? 'new' : 'active';
    } else if (status === 'canceled' || status === 'incomplete_expired') lifecycle = 'churned';
    else lifecycle = 'lapsed';

    // Estimated LTV: monthly-equivalent price × months on plan. Labeled "Est." in
    // the UI — never presented as exact billed revenue.
    const endRef = lifecycle === 'active' || lifecycle === 'new'
      ? now
      : (sub?.current_period_end ? new Date(sub.current_period_end).getTime() : now);
    const estLtvCents = sub ? planMonthlyCents(plan) * monthsBetween(sub.created_at, endRef) : 0;

    return {
      familyId: f.id,
      name: f.name,
      ownerEmail,
      memberCount: active.length,
      plan,
      planLabel: planName(plan),
      status,
      lifecycle,
      estLtvCents,
      createdAt: f.created_at,
      lastActivityAt: f.updated_at,
    };
  });
  return { customers, error: null };
}

export async function getMarketingCustomers(supabase: DB): Promise<MarketingCustomer[]> {
  return (await getMarketingCustomersWithError(supabase)).customers;
}

// ── Segment rule engine (pure, testable) ─────────────────────────────────────

export type SegmentRules = {
  lifecycle?: Lifecycle[];
  plans?: string[];
  minLtvCents?: number;
  createdWithinDays?: number;
  inactiveForDays?: number;
};

export function evaluateSegment(customers: MarketingCustomer[], rules: SegmentRules, now = Date.now()): MarketingCustomer[] {
  return customers.filter((c) => {
    if (rules.lifecycle?.length && !rules.lifecycle.includes(c.lifecycle)) return false;
    if (rules.plans?.length && !rules.plans.includes(c.plan)) return false;
    if (typeof rules.minLtvCents === 'number' && c.estLtvCents < rules.minLtvCents) return false;
    if (typeof rules.createdWithinDays === 'number') {
      if (new Date(c.createdAt).getTime() < now - rules.createdWithinDays * DAY) return false;
    }
    if (typeof rules.inactiveForDays === 'number') {
      if (new Date(c.lastActivityAt).getTime() > now - rules.inactiveForDays * DAY) return false;
    }
    return true;
  });
}

export type CustomerMetrics = {
  total: number;
  paying: number;
  newThisMonth: number;
  lapsed: number;
  estMrrCents: number;
  estLtvCents: number;
  byLifecycle: Record<Lifecycle, number>;
};

export function summarizeCustomers(customers: MarketingCustomer[]): CustomerMetrics {
  const byLifecycle: Record<Lifecycle, number> = { new: 0, active: 0, lapsed: 0, churned: 0, free: 0 };
  let paying = 0, estMrrCents = 0, estLtvCents = 0;
  for (const c of customers) {
    byLifecycle[c.lifecycle]++;
    estLtvCents += c.estLtvCents;
    if (c.lifecycle === 'active' || c.lifecycle === 'new') {
      paying++;
      estMrrCents += planMonthlyCents(c.plan);
    }
  }
  return {
    total: customers.length,
    paying,
    newThisMonth: byLifecycle.new,
    lapsed: byLifecycle.lapsed + byLifecycle.churned,
    estMrrCents,
    estLtvCents,
    byLifecycle,
  };
}
