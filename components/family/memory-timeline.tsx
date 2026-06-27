'use client';

// Makes the Family Memory timeline genuinely searchable (the page header has long
// promised it). Pure client-side filtering over the already-loaded memories —
// instant and frictionless — across title, details, type, and who it's about,
// plus a favorites-only toggle. 100% real; the data is the same Supabase rows.
import { useMemo, useState } from 'react';
import { Camera, Quote, Plane, Award, BookHeart, Star, Search, X } from 'lucide-react';
import { MiniEmpty } from '@/components/family/shell';
import { DeleteButton } from '@/components/family/record-actions';
import { fmtDate } from '@/lib/utils/format';
import { cn } from '@/lib/utils/cn';

const KIND_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  photo: Camera, quote: Quote, trip: Plane, achievement: Award, journal: BookHeart, milestone: Star,
};

export type MemoryRow = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  memory_date: string;
  member_id: string | null;
  is_favorite: boolean | null;
};

export function MemoryTimeline({
  memories, members,
}: {
  memories: MemoryRow[];
  members: { id: string; display_name: string }[];
}) {
  const [query, setQuery] = useState('');
  const [favOnly, setFavOnly] = useState(false);
  const nameById = useMemo(() => new Map(members.map((m) => [m.id, m.display_name])), [members]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return memories.filter((m) => {
      if (favOnly && !m.is_favorite) return false;
      if (!q) return true;
      const who = m.member_id ? (nameById.get(m.member_id) ?? '') : '';
      return [m.title, m.body ?? '', m.kind, who, m.memory_date]
        .join(' ').toLowerCase().includes(q);
    });
  }, [memories, query, favOnly, nameById]);

  if (memories.length === 0) {
    return <MiniEmpty icon={Camera} text="No memories yet — capture your first above." />;
  }

  return (
    <div>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search memories — title, details, who, type…"
            className="w-full rounded-xl border border-border bg-surface/40 py-2 pl-9 pr-9 text-sm outline-none transition focus:border-brand/50"
          />
          {query && (
            <button onClick={() => setQuery('')} aria-label="Clear search"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted hover:text-fg">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <button onClick={() => setFavOnly((v) => !v)}
          className={cn('flex shrink-0 items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold transition',
            favOnly ? 'border-amber-400/50 bg-amber-400/10 text-amber-400' : 'border-border bg-surface/40 text-muted hover:text-fg')}>
          <Star className={cn('h-3.5 w-3.5', favOnly && 'fill-amber-400')} /> Favorites
        </button>
      </div>

      {(query || favOnly) && (
        <p className="mb-2 text-xs text-muted">
          {filtered.length} {filtered.length === 1 ? 'memory' : 'memories'}
          {query && <> matching “{query}”</>}
        </p>
      )}

      {filtered.length === 0 ? (
        <MiniEmpty icon={Search} text="No memories match your search." />
      ) : (
        <ul className="space-y-3">
          {filtered.map((m) => {
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
      )}
    </div>
  );
}
