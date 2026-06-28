import type { Metadata } from 'next';
import Link from 'next/link';
import { BookHeart, Award, Plane, Image as ImageIcon, Plus } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { groupByMonth, countMemories, type MemoryItem, type MemoryKind } from '@/lib/memories/timeline';

export const metadata: Metadata = { title: 'Memories' };
export const dynamic = 'force-dynamic';

const KIND_ICON: Record<MemoryKind, typeof Award> = { milestone: Award, trip: Plane, photo: ImageIcon };
const KIND_TINT: Record<MemoryKind, string> = {
  milestone: 'text-amber-300 bg-amber-500/15',
  trip: 'text-blue-300 bg-blue-500/15',
  photo: 'text-pink-300 bg-pink-500/15',
};

export default async function MemoriesPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  const nowIso = new Date().toISOString();

  const [
    { data: milestones },
    { data: trips },
    { data: photos },
  ] = await Promise.all([
    supabase.from('family_milestones').select('id, title, description, milestone_date, member_id').eq('family_id', familyId).order('milestone_date', { ascending: false }).limit(60),
    supabase.from('trips').select('id, name, destination, end_date, start_date').eq('family_id', familyId).not('end_date', 'is', null).lte('end_date', nowIso.slice(0, 10)).order('end_date', { ascending: false }).limit(40),
    supabase.from('family_photos').select('id, caption, taken_at, created_at, thumbnail_url, url, is_favorite').eq('family_id', familyId).order('created_at', { ascending: false }).limit(120),
  ]);

  const items: MemoryItem[] = [
    ...(milestones ?? []).map((m) => ({ id: `m-${m.id}`, kind: 'milestone' as const, title: m.title, subtitle: m.description, date: m.milestone_date, memberId: m.member_id })),
    ...(trips ?? []).map((t) => ({ id: `t-${t.id}`, kind: 'trip' as const, title: t.name, subtitle: t.destination, date: (t.end_date ?? t.start_date) as string })),
    // Only photos that read as "memories": favorites or captioned.
    ...(photos ?? []).filter((p) => p.is_favorite || p.caption).map((p) => ({
      id: `p-${p.id}`, kind: 'photo' as const, title: p.caption || 'Photo', date: (p.taken_at ?? p.created_at), imageUrl: p.thumbnail_url ?? p.url,
    })),
  ];

  const months = groupByMonth(items);
  const total = countMemories(months);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <BookHeart className="h-5 w-5 text-brand" />
        <h1 className="text-lg font-bold">Memories</h1>
        <Link
          href="/dashboard/memories/create"
          className="ml-auto inline-flex items-center gap-1.5 rounded-xl bg-brand px-3 py-2 text-sm font-semibold text-brand-fg transition hover:brightness-110"
        >
          <Plus className="h-4 w-4" /> Create memory
        </Link>
      </div>

      {total === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-border bg-surface/40 py-16 text-center">
          <BookHeart className="h-10 w-10 text-muted/40" />
          <p className="mt-3 text-muted">Your family memory lane is empty — add a favorite photo, log a trip, or record a milestone.</p>
          <Link
            href="/dashboard/memories/create"
            className="mt-5 inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-brand-fg transition hover:brightness-110"
          >
            <Plus className="h-4 w-4" /> Create your first memory
          </Link>
        </div>
      ) : (
        <div className="space-y-8">
          {months.map((month) => (
            <section key={month.key}>
              <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-muted">{month.label}</h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {month.items.map((item) => {
                  const Icon = KIND_ICON[item.kind];
                  return (
                    <div key={item.id} className="overflow-hidden rounded-2xl border border-border bg-surface/40">
                      {item.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={item.imageUrl} alt={item.title} className="h-36 w-full object-cover" />
                      ) : (
                        <div className={`flex h-36 items-center justify-center ${KIND_TINT[item.kind]}`}><Icon className="h-9 w-9" /></div>
                      )}
                      <div className="p-3">
                        <div className="flex items-center gap-2">
                          <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full ${KIND_TINT[item.kind]}`}><Icon className="h-3.5 w-3.5" /></span>
                          <p className="truncate text-sm font-semibold">{item.title}</p>
                        </div>
                        {item.subtitle && <p className="mt-1 truncate text-xs text-muted">{item.subtitle}</p>}
                        <p className="mt-1 text-xs text-muted">{new Date(item.date + (item.date.length === 10 ? 'T00:00:00' : '')).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
