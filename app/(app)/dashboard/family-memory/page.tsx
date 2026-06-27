import type { Metadata } from 'next';
import { Award, BookHeart, Star, Sparkles } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { PageHeader } from '@/components/app/page-header';
import { SectionCard, StatTile } from '@/components/family/shell';
import { QuickAdd } from '@/components/family/quick-add';
import { fmtDate } from '@/lib/utils/format';
import { MemoryTimeline } from '@/components/family/memory-timeline';

export const metadata: Metadata = { title: 'Family Memory' };
export const dynamic = 'force-dynamic';

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
        <MemoryTimeline memories={memories ?? []} nameById={Object.fromEntries(nameById)} />
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
