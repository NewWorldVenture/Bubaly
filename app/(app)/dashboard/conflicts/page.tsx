import type { Metadata } from 'next';
import Link from 'next/link';
import { CalendarClock, ArrowLeft } from 'lucide-react';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { detectConflicts, quickFixMoveAfter, type TimedEvent } from '@/lib/family/conflicts';
import { ConflictResolver, type ConflictView } from '@/components/family/conflict-resolver';

export const metadata: Metadata = { title: 'AI Conflict Resolution' };
export const dynamic = 'force-dynamic';

function whenLabel(startsAt: string, endsAt: string | null): string {
  const s = new Date(startsAt);
  const start = s.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  if (!endsAt) return start;
  const e = new Date(endsAt);
  const sameDay = s.toDateString() === e.toDateString();
  const end = e.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return sameDay ? `${start} – ${end}` : `${start} → ${e.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
}

export default async function ConflictsPage() {
  const ctx = await requirePlanLevel(2);
  const supabase = await createServer();
  const familyId = ctx.active.familyId;

  const now = new Date();
  const in14 = new Date(now.getTime() + 14 * 24 * 3_600_000);

  const [{ data: events }, { data: members }] = await Promise.all([
    supabase
      .from('calendar_events')
      .select('id, title, starts_at, ends_at, all_day, location, assignee_id')
      .eq('family_id', familyId)
      .gte('starts_at', now.toISOString())
      .lte('starts_at', in14.toISOString())
      .order('starts_at', { ascending: true }),
    supabase.from('family_members').select('id, display_name').eq('family_id', familyId),
  ]);

  const nameById = new Map((members ?? []).map((m) => [m.id, m.display_name]));
  const timed: TimedEvent[] = (events ?? []).map((e) => ({
    id: e.id, title: e.title, starts_at: e.starts_at, ends_at: e.ends_at, all_day: e.all_day,
    location: e.location, assignee_id: e.assignee_id,
  }));

  const conflicts = detectConflicts(timed);
  const views: ConflictView[] = conflicts.map((c) => {
    const qf = quickFixMoveAfter(c);
    const ev = (e: TimedEvent) => ({
      id: e.id,
      title: e.title,
      whenLabel: whenLabel(e.starts_at, e.ends_at),
      location: e.location ?? null,
      assignee: e.assignee_id ? nameById.get(e.assignee_id) ?? null : null,
    });
    return {
      key: `${c.a.id}:${c.b.id}`,
      a: ev(c.a),
      b: ev(c.b),
      overlapLabel: `Overlaps ${c.overlapMinutes} min`,
      quickFix: qf
        ? {
            eventId: qf.eventId,
            label: qf.label,
            startsAtIso: qf.startsAtIso,
            endsAtIso: qf.endsAtIso,
            newWhenLabel: whenLabel(qf.startsAtIso, qf.endsAtIso),
          }
        : null,
      aiPayload: {
        a: { title: c.a.title, starts_at: c.a.starts_at, ends_at: c.a.ends_at, location: c.a.location ?? null },
        b: { title: c.b.title, starts_at: c.b.starts_at, ends_at: c.b.ends_at, location: c.b.location ?? null },
      },
    };
  });

  return (
    <div className="module-page">
      <Link href="/dashboard/command-center" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft className="h-4 w-4" /> Command Center
      </Link>
      <div className="flex items-center gap-3">
        <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-brand/10 text-brand">
          <CalendarClock className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">AI Conflict Resolution</h1>
          <p className="text-sm text-muted">Overlapping events in the next two weeks, with one-tap fixes and AI suggestions.</p>
        </div>
      </div>

      <ConflictResolver conflicts={views} />
    </div>
  );
}
