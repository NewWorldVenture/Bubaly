import 'server-only';
import { settleAll } from '@/lib/supabase/settle';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { planMonthlyCents, planName } from '@/lib/constants/plans';
import { readAllByIdAsQuery } from '@/lib/supabase/read-all';

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
  /** families.closed_at — set when the family closed its account. */
  closedAt?: string | null;
};

const DAY = 86_400_000;
/** The families and subscriptions the view reads before it reports a prefix; the smallest of its ceilings. */
export const CUSTOMER_FAMILY_CEILING = 2000;
/** The members and profiles it joins on before it reports a prefix. */
const CUSTOMER_MEMBER_CEILING = 20000;

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
export async function getMarketingCustomersWithError(supabase: DB): Promise<{
  customers: MarketingCustomer[];
  error: unknown | null;
  /**
   * The error is that a read below reached its ceiling, and nothing failed.
   * Every caller still gets the error and no customers — a send or a segment
   * built from part of the families is a wrong one — but a dashboard can show
   * its customer figures as not shown instead of losing the page to them.
   */
  truncated?: boolean;
}> {
  const [familiesResult, subsResult, membersResult, profilesResult] = await settleAll([
    // Every customer is one family row, and the customers are counted and their
    // plans summed (Est. MRR, Customer Acquisition), so the families page on
    // the id, not on offsets. Read newest first by offset, a family signing up
    // between two pages took offset 0 and pushed the last family of one page
    // onto the next: one household was two customers. Sorted newest first below.
    readAllByIdAsQuery((after, limit) => {
      let query = supabase.from('families').select('id, name, created_at, updated_at, closed_at');
      if (after) query = query.gt('id', after);
      return query.order('id').limit(limit);
    }, { max: CUSTOMER_FAMILY_CEILING }),
    // The three sibling reads below page for the same reason the families read
    // does: each is joined BACK onto the families list, so a read capped at
    // db-max-rows does not shorten the table — it silently mislabels customers
    // whose rows fell off the end (no subscription found reads as 'free', no
    // members reads as a household of zero, no profile as an unknown owner).
    // And each pages on the id, not on offsets, because families check out,
    // join and leave WHILE it reads: a member added ahead of the next offset
    // repeated the last member of a page and one household counted a member
    // twice; a subscription removed ahead of it skipped the next one, and a
    // family that pays read as free in Est. MRR. The id is the total order.
    readAllByIdAsQuery((after, limit) => {
      let query = supabase.from('subscriptions').select('id, family_id, plan, status, created_at, current_period_end');
      if (after) query = query.gt('id', after);
      return query.order('id').limit(limit);
    }, { max: CUSTOMER_FAMILY_CEILING }),
    readAllByIdAsQuery((after, limit) => {
      let query = supabase.from('family_members').select('id, family_id, user_id, role, is_active');
      if (after) query = query.gt('id', after);
      return query.order('id').limit(limit);
    }, { max: CUSTOMER_MEMBER_CEILING }),
    readAllByIdAsQuery((after, limit) => {
      let query = supabase.from('profiles').select('id, email');
      if (after) query = query.gt('id', after);
      return query.order('id').limit(limit);
    }, { max: CUSTOMER_MEMBER_CEILING }),
  ]);

  const results = [familiesResult, subsResult, membersResult, profilesResult];
  const error = familiesResult.error ?? subsResult.error ?? membersResult.error ?? profilesResult.error;
  if (error) {
    const truncated = results.every((r) => !r.error || ('truncated' in r && r.truncated));
    return { customers: [], error, truncated };
  }

  const { data: families } = familiesResult;
  const { data: subs } = subsResult;
  const { data: members } = membersResult;
  const { data: profiles } = profilesResult;

  const emailByUser = new Map((profiles ?? []).map((p) => [p.id, p.email]));
  // In id order the LAST subscription a family has wins, as it did when the
  // read was sorted by family and then id.
  const subByFamily = new Map((subs ?? []).map((s) => [s.family_id, s]));

  // The owner is the first parent with an account in (user_id, id) order —
  // the order the members were read in before they paged on the id alone.
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const byUserThenId = [...(members ?? [])].sort((a, b) =>
    (a.user_id === null ? 1 : 0) - (b.user_id === null ? 1 : 0)
    || cmp(a.user_id ?? '', b.user_id ?? '')
    || cmp(a.id, b.id));
  const membersByFamily = new Map<string, typeof members>();
  for (const m of byUserThenId) {
    if (!membersByFamily.has(m.family_id)) membersByFamily.set(m.family_id, [] as never);
    membersByFamily.get(m.family_id)!.push(m);
  }

  const now = Date.now();

  // Newest first, the order every customer list has always read in.
  const newestFirst = [...(families ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
  const customers = newestFirst.map((f) => {
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
      closedAt: f.closed_at ?? null,
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
