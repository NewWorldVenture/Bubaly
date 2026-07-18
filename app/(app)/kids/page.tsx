import type { Metadata } from 'next';
import Link from 'next/link';
import { CheckCircle2, Star, CalendarDays, Trophy, PartyPopper } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isMissingTableError } from '@/lib/supabase/errors';
import { Avatar } from '@/components/ui/avatar';
import { ErrorState } from '@/components/ui/states';
import { fmtTime, firstName } from '@/lib/utils/format';

export const metadata: Metadata = { title: 'My Bubaly' };
export const dynamic = 'force-dynamic';

export default async function KidsPage() {
  const ctx = await requireUserContext();
  const me = ctx.active.member;
  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 86400000);

  // Only the child's own tasks + shared family events. No finance/health.
  const [myTasksRes, doneRes, eventsRes] = await Promise.all([
    supabase.from('chore_assignments').select('id, chore_id, status, due_at').eq('family_id', familyId).eq('member_id', me.id).in('status', ['todo', 'in_progress']).order('due_at').limit(10),
    supabase.from('chore_assignments').select('points_awarded').eq('family_id', familyId).eq('member_id', me.id).in('status', ['done', 'approved']),
    supabase.from('calendar_events').select('id, title, starts_at, all_day').eq('family_id', familyId).gte('starts_at', start.toISOString()).lt('starts_at', end.toISOString()).order('starts_at').limit(6),
  ]);

  // A dropped error would tell the child "All done! 🎉 No jobs left today." and
  // "0 points earned" when they actually have chores and points — a
  // reassuring-but-wrong, motivation-affecting lie. Fail closed on a real read
  // error; a genuinely missing table (unapplied migration) is still tolerated as
  // empty. The dependent chore-title lookup stays best-effort.
  const kidsError = [myTasksRes.error, doneRes.error, eventsRes.error]
    .find((e) => e && !isMissingTableError(e));
  if (kidsError) {
    console.error('[kids] kids dashboard read failed', kidsError);
    return <ErrorState message="We couldn't load your day right now. Try again in a moment!" />;
  }

  const myTasks = myTasksRes.data;
  const done = doneRes.data;
  const events = eventsRes.data;

  const choreIds = [...new Set((myTasks ?? []).map((t) => t.chore_id))];
  const { data: chores } = choreIds.length
    ? await supabase.from('chores').select('id, title, points').in('id', choreIds)
    : { data: [] as { id: string; title: string; points: number }[] };
  const choreById = new Map((chores ?? []).map((c) => [c.id, c]));
  const points = (done ?? []).reduce((s, d) => s + (d.points_awarded ?? 0), 0);

  return (
    <div className="space-y-5 pt-2">
      <div className="flex items-center gap-3">
        <Avatar name={me.display_name} color={me.color} size={56} />
        <div>
          <h1 className="text-2xl font-black">Hi {firstName(me.display_name)}! 👋</h1>
          <p className="text-sm text-muted">Here&apos;s your day.</p>
        </div>
      </div>

      <div className="flex items-center gap-3 rounded-3xl bg-gradient-to-r from-amber-500/20 to-pink-500/20 p-5">
        <div className="grid h-14 w-14 place-items-center rounded-2xl bg-amber-400"><Star className="h-7 w-7 text-white" /></div>
        <div><p className="text-3xl font-black tabular-nums">{points}</p><p className="text-sm font-semibold text-muted">points earned</p></div>
        <PartyPopper className="ml-auto h-8 w-8 text-pink-400" />
      </div>

      <section>
        <h2 className="mb-3 flex items-center gap-2 text-lg font-bold"><CheckCircle2 className="h-5 w-5 text-emerald-400" /> My Jobs</h2>
        {myTasks && myTasks.length > 0 ? (
          <ul className="space-y-3">
            {myTasks.map((t) => {
              const c = choreById.get(t.chore_id);
              return (
                <li key={t.id}>
                  <Link href={`/kids/submit/${t.id}`} className="flex items-center gap-4 rounded-2xl border border-border bg-surface/40 p-4 transition hover:border-brand">
                    <div className="h-7 w-7 shrink-0 rounded-full border-4 border-emerald-400/40" />
                    <span className="flex-1 text-lg font-semibold">{c?.title ?? 'Job'}</span>
                    {c?.points ? <span className="rounded-full bg-amber-400/20 px-3 py-1 text-sm font-bold text-amber-300">+{c.points}</span> : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="rounded-2xl border border-dashed border-border p-8 text-center">
            <Trophy className="mx-auto h-10 w-10 text-amber-400" />
            <p className="mt-2 text-lg font-bold">All done! 🎉</p>
            <p className="text-sm text-muted">No jobs left today.</p>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 flex items-center gap-2 text-lg font-bold"><CalendarDays className="h-5 w-5 text-violet-400" /> Today</h2>
        {events && events.length > 0 ? (
          <ul className="space-y-3">
            {events.map((e) => (
              <li key={e.id} className="flex items-center gap-4 rounded-2xl border border-border bg-surface/40 p-4">
                <span className="w-16 shrink-0 text-sm font-bold text-muted">{e.all_day ? 'All day' : fmtTime(e.starts_at)}</span>
                <span className="text-lg font-semibold">{e.title}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="rounded-2xl border border-dashed border-border p-8 text-center text-muted">Nothing on the calendar today.</div>
        )}
      </section>
    </div>
  );
}
