import type { Metadata } from 'next';
import Link from 'next/link';
import { CheckSquare, ShoppingCart, CalendarDays, Repeat, Wrench, ArrowRight } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isMissingTableError } from '@/lib/supabase/errors';
import { PageHeader } from '@/components/app/page-header';
import { StatTile, SectionCard, MiniEmpty } from '@/components/family/shell';
import { QuickAdd } from '@/components/family/quick-add';
import { DeleteButton } from '@/components/family/record-actions';
import { ErrorState } from '@/components/ui/states';
import { fmtRelative, firstName } from '@/lib/utils/format';

export const metadata: Metadata = { title: 'Family COO' };
export const dynamic = 'force-dynamic';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default async function FamilyCooPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  const now = new Date().toISOString();
  const in7 = new Date(Date.now() + 7 * 86400000).toISOString();

  const [membersRes, openChoresRes, eventsRes, groceryRes, routinesRes, maintRes] = await Promise.all([
    supabase.from('family_members').select('id, display_name').eq('family_id', familyId).eq('is_active', true),
    supabase.from('chore_assignments').select('id, due_at, status, member_id, chore_id').eq('family_id', familyId).in('status', ['todo', 'in_progress']).order('due_at').limit(8),
    supabase.from('calendar_events').select('id, title, starts_at, all_day').eq('family_id', familyId).gte('starts_at', now).lte('starts_at', in7).order('starts_at').limit(6),
    supabase.from('grocery_items').select('id, name').eq('family_id', familyId).eq('is_checked', false).limit(8),
    supabase.from('family_routines').select('*').eq('family_id', familyId).eq('status', 'active').order('created_at'),
    supabase.from('maintenance_tasks').select('id, title, due_at, status').eq('family_id', familyId).in('status', ['todo', 'in_progress']).order('due_at').limit(5),
  ]);

  // Open tasks, this week's events, the shopping list, routines, and
  // maintenance are source-of-truth for "run the household". A dropped error
  // would render "No open tasks — nicely done." (family thinks chores are done),
  // "Nothing scheduled this week", and an empty list — a reassuring-but-wrong
  // operations picture. Fail closed on a real read error; a genuinely missing
  // table (unapplied migration) is still tolerated as empty.
  const cooError = [membersRes.error, openChoresRes.error, eventsRes.error, groceryRes.error, routinesRes.error, maintRes.error]
    .find((e) => e && !isMissingTableError(e));
  if (cooError) {
    console.error('[dashboard/family-coo] household read failed', cooError);
    return <ErrorState message="Could not load your household from Supabase. Refresh and try again." />;
  }

  const members = membersRes.data;
  const openChores = openChoresRes.data;
  const events = eventsRes.data;
  const grocery = groceryRes.data;
  const routines = routinesRes.data;
  const maint = maintRes.data;

  const choreIds = [...new Set((openChores ?? []).map((c) => c.chore_id))];
  const { data: chores } = choreIds.length
    ? await supabase.from('chores').select('id, title').in('id', choreIds)
    : { data: [] as { id: string; title: string }[] };
  const titleById = new Map((chores ?? []).map((c) => [c.id, c.title]));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Family COO"
        description="Run the household: tasks, routines, shopping and maintenance in one place."
        action={
          <QuickAdd
            table="family_routines"
            title="New routine"
            members={members ?? []}
            fields={[
              { name: 'title', label: 'Routine', type: 'text', required: true, placeholder: 'Morning checklist' },
              { name: 'member_id', label: 'Who', type: 'member' },
              { name: 'category', label: 'Category', type: 'text', placeholder: 'morning / evening' },
              { name: 'time_of_day', label: 'Time', type: 'text', placeholder: '7:00 AM' },
              { name: 'description', label: 'Steps', type: 'textarea' },
            ]}
          />
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile href="/dashboard/chores" label="Open tasks" value={openChores?.length ?? 0} icon={CheckSquare} accent="bg-emerald-600" sublabel="Chores" />
        <StatTile href="/dashboard/grocery" label="Grocery items" value={grocery?.length ?? 0} icon={ShoppingCart} accent="bg-blue-600" sublabel="Shopping" />
        <StatTile href="/dashboard/calendar" label="Events (7d)" value={events?.length ?? 0} icon={CalendarDays} accent="bg-violet-600" sublabel="Calendar" />
        <StatTile href="/dashboard/home" label="Maintenance" value={maint?.length ?? 0} icon={Wrench} accent="bg-orange-500" sublabel="Home" />
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        <SectionCard title="Task Assignments" viewAllHref="/dashboard/chores">
          {openChores && openChores.length > 0 ? (
            <ul className="divide-y divide-border">
              {openChores.map((t) => {
                const who = (members ?? []).find((m) => m.id === t.member_id);
                return (
                  <li key={t.id} className="flex items-center gap-3 py-2.5">
                    <div className="h-4 w-4 shrink-0 rounded-full border-2 border-border" />
                    <span className="min-w-0 flex-1 truncate text-sm">{titleById.get(t.chore_id) ?? 'Task'}</span>
                    {t.due_at && <span className="text-xs text-muted">{fmtRelative(t.due_at)}</span>}
                    {who && <span className="rounded-full bg-violet-500/20 px-2 py-0.5 text-xs font-semibold text-brand-text">{firstName(who.display_name)}</span>}
                  </li>
                );
              })}
            </ul>
          ) : <MiniEmpty icon={CheckSquare} text="No open tasks — nicely done." />}
        </SectionCard>

        <SectionCard title="Household Routines" description="Recurring rhythms that keep things running">
          {routines && routines.length > 0 ? (
            <ul className="divide-y divide-border">
              {routines.map((r) => {
                const who = (members ?? []).find((m) => m.id === r.member_id);
                return (
                  <li key={r.id} className="flex items-center gap-3 py-2.5">
                    <Repeat className="h-4 w-4 shrink-0 text-violet-400" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{r.title}</p>
                      <p className="text-xs text-muted">{[r.time_of_day, r.category].filter(Boolean).join(' · ') || 'Routine'}</p>
                    </div>
                    {who && <span className="text-xs text-muted">{firstName(who.display_name)}</span>}
                    <DeleteButton table="family_routines" id={r.id} />
                  </li>
                );
              })}
            </ul>
          ) : <MiniEmpty icon={Repeat} text="No routines yet — add your first above." />}
        </SectionCard>
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        <SectionCard title="This Week" viewAllHref="/dashboard/calendar">
          {events && events.length > 0 ? (
            <ul className="space-y-2.5">
              {events.map((e) => {
                const d = new Date(e.starts_at);
                return (
                  <li key={e.id} className="flex items-center gap-3 text-sm">
                    <span className="w-10 shrink-0 text-xs text-muted">{DAYS[d.getDay()]}</span>
                    <span className="min-w-0 flex-1 truncate">{e.title}</span>
                  </li>
                );
              })}
            </ul>
          ) : <MiniEmpty icon={CalendarDays} text="Nothing scheduled this week." />}
        </SectionCard>

        <SectionCard title="Shopping List" viewAllHref="/dashboard/grocery">
          {grocery && grocery.length > 0 ? (
            <ul className="grid grid-cols-2 gap-2 text-sm">
              {grocery.map((g) => (
                <li key={g.id} className="flex items-center gap-2"><span className="h-3.5 w-3.5 rounded border border-white/20" />{g.name}</li>
              ))}
            </ul>
          ) : (
            <div className="py-6 text-center">
              <Link href="/dashboard/grocery" className="inline-flex items-center gap-1 text-sm font-semibold text-brand-text">Build a list <ArrowRight className="h-3.5 w-3.5" /></Link>
            </div>
          )}
        </SectionCard>
      </div>
    </div>
  );
}
