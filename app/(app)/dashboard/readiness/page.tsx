import type { Metadata } from 'next';
import Link from 'next/link';
import { Gauge, TrendingUp, TrendingDown, Sparkles, ArrowRight } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { computeReadiness, BAND_LABEL, type ReadinessInput } from '@/lib/readiness/score';
import { planLevel } from '@/lib/constants/plans';

export const metadata: Metadata = { title: 'Family Readiness' };
export const dynamic = 'force-dynamic';

const BAND_COLOR = {
  great: 'text-emerald-400', good: 'text-blue-400', attention: 'text-amber-400', at_risk: 'text-rose-400',
} as const;

export default async function ReadinessPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const now = new Date();
  const weekEnd = new Date(now); weekEnd.setDate(weekEnd.getDate() + 7);
  const todayStr = now.toISOString().slice(0, 10);
  const weekEndStr = weekEnd.toISOString().slice(0, 10);

  const [
    { count: choresOverdue },
    { count: remindersOverdue },
    { data: meals },
    { count: eventsUpcoming },
    { count: groceryActive },
    { count: activeMembers },
    { data: sub },
  ] = await Promise.all([
    supabase.from('chore_assignments').select('id', { count: 'exact', head: true }).eq('family_id', familyId).in('status', ['todo', 'in_progress']).lt('due_at', now.toISOString()),
    supabase.from('reminders').select('id', { count: 'exact', head: true }).eq('family_id', familyId).eq('is_done', false).lt('remind_at', now.toISOString()),
    supabase.from('meal_plans').select('plan_date').eq('family_id', familyId).gte('plan_date', todayStr).lte('plan_date', weekEndStr),
    supabase.from('calendar_events').select('id', { count: 'exact', head: true }).eq('family_id', familyId).gte('starts_at', now.toISOString()).lt('starts_at', weekEnd.toISOString()),
    supabase.from('grocery_items').select('id', { count: 'exact', head: true }).eq('family_id', familyId).eq('is_checked', false),
    supabase.from('family_members').select('id', { count: 'exact', head: true }).eq('family_id', familyId).eq('is_active', true),
    supabase.from('subscriptions').select('plan, status').eq('family_id', familyId).in('status', ['active', 'trialing']).maybeSingle(),
  ]);

  const input: ReadinessInput = {
    choresOverdue: choresOverdue ?? 0,
    remindersOverdue: remindersOverdue ?? 0,
    mealsPlanned: new Set((meals ?? []).map((m) => m.plan_date)).size,
    eventsUpcoming: eventsUpcoming ?? 0,
    groceryActive: groceryActive ?? 0,
    activeMembers: activeMembers ?? 0,
  };
  const { score, band, factors } = computeReadiness(input);
  const isPlus = planLevel(sub?.plan ?? null) >= 2;

  // SVG ring math.
  const r = 54, c = 2 * Math.PI * r, dash = (score / 100) * c;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <Gauge className="h-5 w-5 text-brand" />
        <h1 className="text-lg font-bold">Family Readiness</h1>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col items-center justify-center rounded-3xl border border-border bg-surface/40 p-6">
          <svg viewBox="0 0 128 128" className="h-40 w-40 -rotate-90">
            <circle cx="64" cy="64" r={r} fill="none" stroke="currentColor" strokeWidth="12" className="text-elevated" />
            <circle cx="64" cy="64" r={r} fill="none" stroke="currentColor" strokeWidth="12" strokeLinecap="round"
              strokeDasharray={`${dash} ${c}`} className={BAND_COLOR[band]} />
          </svg>
          <p className={`-mt-28 text-4xl font-black ${BAND_COLOR[band]}`}>{score}</p>
          <p className="mt-20 text-sm font-semibold">{BAND_LABEL[band]}</p>
        </div>

        <div className="rounded-3xl border border-border bg-surface/40 p-6 lg:col-span-2">
          <h2 className="mb-4 text-base font-semibold">What&apos;s driving your score</h2>
          {factors.length === 0 ? (
            <p className="text-sm text-muted">Add events, chores, and meals to see what shapes your readiness.</p>
          ) : (
            <ul className="space-y-2">
              {factors.map((f, i) => (
                <li key={i} className="flex items-center gap-3 text-sm">
                  {f.good ? <TrendingUp className="h-4 w-4 shrink-0 text-emerald-400" /> : <TrendingDown className="h-4 w-4 shrink-0 text-rose-400" />}
                  <span className="flex-1">{f.label}</span>
                  {f.delta !== 0 && <span className={`tabular-nums ${f.good ? 'text-emerald-400' : 'text-rose-400'}`}>{f.delta > 0 ? '+' : ''}{f.delta}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {!isPlus && (
        <Link href="/dashboard/billing?upgrade=1&need=2" className="group flex items-center gap-4 rounded-3xl border border-brand/30 bg-gradient-to-br from-violet-600/10 to-blue-900/10 p-5 transition hover:border-brand/50">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand/15"><Sparkles className="h-5 w-5 text-brand" /></div>
          <div className="flex-1">
            <p className="font-semibold">Want the full picture?</p>
            <p className="text-sm text-muted">Family+ adds live Stress &amp; Operations scores, predictive alerts, and the AI Command Center.</p>
          </div>
          <ArrowRight className="h-5 w-5 text-muted transition group-hover:translate-x-0.5 group-hover:text-brand" />
        </Link>
      )}
    </div>
  );
}
