import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Gauge, AlertTriangle, CalendarClock, CheckCircle2, UtensilsCrossed,
  FileWarning, Users, ArrowRight,
} from 'lucide-react';
import { requireFeature } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { Avatar } from '@/components/ui/avatar';
import { fmtTime, fmtDate } from '@/lib/utils/format';
import { cn } from '@/lib/utils/cn';
import { loadOperatingIndex } from '@/lib/operating-index/server';
import { ChangeRecap } from '@/components/operating-index/change-recap';

export const metadata: Metadata = { title: 'Command Center' };
export const dynamic = 'force-dynamic';

const HOUR = 3600_000;

type Issue = { icon: typeof AlertTriangle; text: string; href: string; severity: 'high' | 'medium' };

// Family+ feature — the AI Family Command Center. Every figure is computed from
// real family data; nothing is fabricated.
export default async function CommandCenterPage() {
  const ctx = await requireFeature('/dashboard/command-center');
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const now = new Date();
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const weekEnd = new Date(start); weekEnd.setDate(weekEnd.getDate() + 7);
  const in30 = new Date(start); in30.setDate(in30.getDate() + 30);

  const [
    { data: members },
    { data: events },
    { data: openChores },
    { data: mealPlans },
    { data: expiringDocs },
  ] = await Promise.all([
    supabase.from('family_members').select('id, display_name, color').eq('family_id', familyId).eq('is_active', true),
    supabase.from('calendar_events').select('id, title, starts_at, ends_at, all_day, location, assignee_id')
      .eq('family_id', familyId).gte('starts_at', now.toISOString()).lte('starts_at', weekEnd.toISOString()).order('starts_at'),
    supabase.from('chore_assignments').select('id, due_at, status, member_id')
      .eq('family_id', familyId).in('status', ['todo', 'in_progress']),
    supabase.from('meal_plans').select('plan_date, meal_type').eq('family_id', familyId)
      .gte('plan_date', start.toISOString().slice(0, 10)).lt('plan_date', weekEnd.toISOString().slice(0, 10)),
    supabase.from('documents').select('id, title, expires_at').eq('family_id', familyId)
      .not('expires_at', 'is', null).gte('expires_at', now.toISOString()).lte('expires_at', in30.toISOString()),
  ]);

  const memberById = new Map((members ?? []).map((m) => [m.id, m]));

  // Evening "what changed" recap — the same FOI diff shown on the Operating
  // Index, brought into the Command Center (pillar #5). Degrades to null-safe.
  const { change } = await loadOperatingIndex(supabase, familyId, now);

  // ── Schedule conflict detection (overlapping timed events) ──
  const timed = (events ?? []).filter((e) => !e.all_day);
  const conflicts: { a: typeof timed[number]; b: typeof timed[number] }[] = [];
  for (let i = 0; i < timed.length; i++) {
    const aStart = new Date(timed[i].starts_at).getTime();
    const aEnd = timed[i].ends_at ? new Date(timed[i].ends_at!).getTime() : aStart + HOUR;
    for (let j = i + 1; j < timed.length; j++) {
      const bStart = new Date(timed[j].starts_at).getTime();
      if (bStart >= aEnd) break; // sorted by start — no further overlaps with i
      const bEnd = timed[j].ends_at ? new Date(timed[j].ends_at!).getTime() : bStart + HOUR;
      if (bStart < aEnd && aStart < bEnd) conflicts.push({ a: timed[i], b: timed[j] });
    }
  }

  // ── Other real signals ──
  const overdue = (openChores ?? []).filter((c) => c.due_at && new Date(c.due_at) < now);
  const plannedDinnerDays = new Set((mealPlans ?? []).filter((m) => m.meal_type === 'dinner').map((m) => m.plan_date));
  const unplannedDinners = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start); d.setDate(d.getDate() + i);
    return d.toISOString().slice(0, 10);
  }).filter((day) => !plannedDinnerDays.has(day));
  const unassignedEvents = (events ?? []).filter((e) => !e.assignee_id);

  // ── Family Readiness Score (0–100), deterministic from the signals above ──
  const penalties =
    Math.min(overdue.length * 5, 25) +
    Math.min(unplannedDinners.length * 3, 21) +
    Math.min((expiringDocs ?? []).length * 4, 16) +
    Math.min(conflicts.length * 8, 24) +
    Math.min(unassignedEvents.length * 2, 14);
  const score = Math.max(0, 100 - penalties);
  const scoreLabel = score >= 85 ? 'On track' : score >= 60 ? 'Needs attention' : 'Action required';
  const scoreColor = score >= 85 ? '#22c55e' : score >= 60 ? '#fbbf24' : '#f87171';

  const issues: Issue[] = [];
  for (const c of conflicts) issues.push({ icon: CalendarClock, severity: 'high', href: '/dashboard/conflicts', text: `Schedule conflict: “${c.a.title}” overlaps “${c.b.title}” (${fmtTime(c.a.starts_at)})` });
  if (overdue.length) issues.push({ icon: CheckCircle2, severity: 'high', href: '/dashboard/chores', text: `${overdue.length} overdue ${overdue.length === 1 ? 'chore' : 'chores'}` });
  if (unplannedDinners.length) issues.push({ icon: UtensilsCrossed, severity: 'medium', href: '/dashboard/meals', text: `${unplannedDinners.length} ${unplannedDinners.length === 1 ? 'day' : 'days'} this week without a planned dinner` });
  for (const d of expiringDocs ?? []) issues.push({ icon: FileWarning, severity: 'medium', href: '/dashboard/documents', text: `“${d.title}” expires ${d.expires_at ? fmtDate(d.expires_at) : 'soon'}` });
  if (unassignedEvents.length) issues.push({ icon: Users, severity: 'medium', href: '/dashboard/calendar', text: `${unassignedEvents.length} upcoming ${unassignedEvents.length === 1 ? 'event has' : 'events have'} no one assigned` });

  const r = 52; const circ = 2 * Math.PI * r;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Family Command Center</h1>
        <p className="mt-1 text-sm text-muted">A live readiness view of your week — conflicts, gaps, and what needs attention.</p>
      </div>

      {/* Since yesterday — the evening "what changed" recap (pillar #5) */}
      <ChangeRecap change={change} />

      <div className="grid gap-5 lg:grid-cols-3">
        {/* Readiness score */}
        <div className="rounded-2xl border border-border bg-surface/40 p-6">
          <h2 className="mb-4 flex items-center gap-2 font-semibold"><Gauge className="h-4 w-4 text-brand-text" /> Family Readiness</h2>
          <div className="flex items-center gap-5">
            <div className="relative h-32 w-32 shrink-0">
              <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90">
                <circle cx="60" cy="60" r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="12" />
                <circle cx="60" cy="60" r={r} fill="none" stroke={scoreColor} strokeWidth="12" strokeLinecap="round"
                  strokeDasharray={`${(score / 100) * circ} ${circ}`} />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-3xl font-black">{score}</span>
                <span className="text-[10px] text-muted">/ 100</span>
              </div>
            </div>
            <div>
              <p className="text-lg font-bold" style={{ color: scoreColor }}>{scoreLabel}</p>
              <p className="mt-1 text-sm text-muted">{issues.length === 0 ? 'Everything looks handled for the week.' : `${issues.length} ${issues.length === 1 ? 'item needs' : 'items need'} your attention.`}</p>
            </div>
          </div>
        </div>

        {/* Needs attention */}
        <div className="rounded-2xl border border-border bg-surface/40 p-6 lg:col-span-2">
          <h2 className="mb-4 flex items-center gap-2 font-semibold"><AlertTriangle className="h-4 w-4 text-amber-400" /> Needs Attention</h2>
          {issues.length === 0 ? (
            <div className="flex flex-col items-center py-8 text-center">
              <CheckCircle2 className="h-10 w-10 text-emerald-400/70" />
              <p className="mt-2 text-sm text-muted">No conflicts or gaps detected this week. Nicely run.</p>
            </div>
          ) : (
            <ul className="space-y-2">
              {issues.slice(0, 8).map((it, i) => (
                <li key={i}>
                  <Link href={it.href} className="group flex items-center gap-3 rounded-xl border border-border bg-surface/30 px-4 py-2.5 text-sm transition hover:border-brand/40">
                    <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg', it.severity === 'high' ? 'bg-rose-500/15 text-rose-400' : 'bg-amber-500/15 text-amber-400')}>
                      <it.icon className="h-4 w-4" />
                    </span>
                    <span className="flex-1">{it.text}</span>
                    <ArrowRight className="h-4 w-4 shrink-0 text-muted opacity-0 transition group-hover:opacity-100" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* This week at a glance */}
      <div className="rounded-2xl border border-border bg-surface/40 p-6">
        <h2 className="mb-4 flex items-center gap-2 font-semibold"><CalendarClock className="h-4 w-4 text-violet-300" /> This Week</h2>
        {(events ?? []).length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">No events scheduled in the next 7 days.</p>
        ) : (
          <ul className="divide-y divide-border/50">
            {(events ?? []).slice(0, 12).map((e) => {
              const who = e.assignee_id ? memberById.get(e.assignee_id) : undefined;
              const inConflict = conflicts.some((c) => c.a.id === e.id || c.b.id === e.id);
              return (
                <li key={e.id} className="flex items-center gap-3 py-2.5">
                  <span className="w-32 shrink-0 text-xs text-muted">{fmtDate(e.starts_at)} · {e.all_day ? 'All day' : fmtTime(e.starts_at)}</span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{e.title}</span>
                  {inConflict && <span className="shrink-0 rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] font-semibold text-rose-400">Conflict</span>}
                  {who ? <Avatar name={who.display_name} color={who.color} size={24} /> : <span className="shrink-0 text-[11px] text-muted/60">Unassigned</span>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
