import type { Metadata } from 'next';
import { Camera, Quote, Plane, Award, BookHeart, Star, Sparkles } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { PageHeader } from '@/components/app/page-header';
import { SectionCard, MiniEmpty, StatTile } from '@/components/family/shell';
import { QuickAdd } from '@/components/family/quick-add';
import { DeleteButton } from '@/components/family/record-actions';
import { fmtDate } from '@/lib/utils/format';

export const metadata: Metadata = { title: 'Family Memory' };
export const dynamic = 'force-dynamic';

const KIND_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  photo: Camera, quote: Quote, trip: Plane, achievement: Award, journal: BookHeart, milestone: Star,
};

export default async function FamilyMemoryPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const [{ data: members }, { data: memories }, { data: milestones }] = await Promise.all([
    supabase.from('family_members').select('id, display_name').eq('family_id', familyId).eq('is_active', true),
    supabase.from('family_memories').select('*').eq('family_id', familyId).is('deleted_at', null).order('memory_date', { ascending: false }).limit(40),
    supabase.from('family_milestones').select('*').eq('family_id', familyId).order('milestone_date', { ascending: false }).limit(12),
  ]);

  const nameById = new Map((members ?? []).map((m) => [m.id, m.display_name]));
  const thisYear = new Date().getFullYear();
  const yearCount = (memories ?? []).filter((m) => m.memory_date.startsWith(`${thisYear}`)).length;
  const favorites = (memories ?? []).filter((m) => m.is_favorite).length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Family Memory Brain"
        description="A searchable timeline of photos, quotes, trips, milestones and journal entries."
        action={
          <QuickAdd
            table="family_memories"
            title="Add memory"
            members={members ?? []}
            fields={[
              { name: 'title', label: 'Title', type: 'text', required: true, placeholder: 'First day of school' },
              { name: 'kind', label: 'Type', type: 'select', options: [
                { value: 'photo', label: 'Photo' }, { value: 'quote', label: 'Quote' },
                { value: 'trip', label: 'Trip' }, { value: 'achievement', label: 'Achievement' },
                { value: 'journal', label: 'Journal' }, { value: 'milestone', label: 'Milestone' },
              ] },
              { name: 'member_id', label: 'Who', type: 'member' },
              { name: 'memory_date', label: 'Date', type: 'date' },
              { name: 'body', label: 'Details', type: 'textarea' },
            ]}
          />
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Total memories" value={memories?.length ?? 0} icon={BookHeart} accent="bg-violet-600" />
        <StatTile label={`In ${thisYear}`} value={yearCount} icon={Sparkles} accent="bg-blue-600" />
        <StatTile label="Favorites" value={favorites} icon={Star} accent="bg-amber-500" />
        <StatTile label="Milestones" value={milestones?.length ?? 0} icon={Award} accent="bg-emerald-600" />
      </div>

      <SectionCard title="Timeline" description="Most recent first">
        {memories && memories.length > 0 ? (
          <ul className="space-y-3">
            {memories.map((m) => {
              const Icon = KIND_ICON[m.kind] ?? BookHeart;
              return (
                <li key={m.id} className="flex items-start gap-3 rounded-xl bg-surface/40 p-3">
                  <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-violet-500/15">
                    <Icon className="h-4 w-4 text-brand" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm font-medium">{m.title}{m.is_favorite && <Star className="h-3.5 w-3.5 text-amber-400" />}</p>
                    {m.body && <p className="mt-0.5 line-clamp-2 text-xs text-muted">{m.body}</p>}
                    <p className="mt-1 text-xs text-muted">{[fmtDate(m.memory_date), m.member_id ? nameById.get(m.member_id) : null].filter(Boolean).join(' · ')}</p>
                  </div>
                  <DeleteButton table="family_memories" id={m.id} />
                </li>
              );
            })}
          </ul>
        ) : <MiniEmpty icon={Camera} text="No memories yet — capture your first above." />}
      </SectionCard>

      {milestones && milestones.length > 0 && (
        <SectionCard title="Milestones">
          <ul className="grid gap-2 sm:grid-cols-2">
            {milestones.map((ms) => (
              <li key={ms.id} className="flex items-center gap-2 rounded-xl bg-surface/40 p-3 text-sm">
                <Star className="h-4 w-4 shrink-0 text-amber-400" />
                <span className="min-w-0 flex-1 truncate">{ms.title}</span>
                <span className="text-xs text-muted">{fmtDate(ms.milestone_date)}</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}
    </div>
  );
}
