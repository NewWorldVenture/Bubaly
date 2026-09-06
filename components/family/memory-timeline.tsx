'use client';

// Searchable Family Memory timeline. A thin client shell over the pure,
// unit-tested filterMemories helper — the page promises "a searchable timeline",
// this delivers it: live text search across title/body/kind/who/date plus a
// favorites-only toggle, with the same row rendering as before.
import { useMemo, useState } from 'react';
import { Camera, Quote, Plane, Award, BookHeart, Star, Search, X } from 'lucide-react';
import { MiniEmpty } from '@/components/family/shell';
import { DeleteButton } from '@/components/family/record-actions';
import { fmtDate } from '@/lib/utils/format';
import { filterMemories, type SearchableMemory } from '@/lib/family/memory-search';
import { useTranslations } from '@/components/i18n/locale-provider';

const KIND_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  photo: Camera, quote: Quote, trip: Plane, achievement: Award, journal: BookHeart, milestone: Star,
};

export type TimelineMemory = SearchableMemory;

export function MemoryTimeline({ memories, nameById }: {
  memories: TimelineMemory[];
  nameById: Record<string, string>;
}) {
  const t = useTranslations();
  const [query, setQuery] = useState('');
  const [favoritesOnly, setFavoritesOnly] = useState(false);

  const nameOf = useMemo(() => (id: string | null) => (id ? nameById[id] ?? '' : ''), [nameById]);
  const filtered = useMemo(
    () => filterMemories(memories, { query, favoritesOnly }, nameOf),
    [memories, query, favoritesOnly, nameOf],
  );

  return (
    <div className="space-y-3">
      {/* Search + favorites toggle */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder={t('memoryTimeline.searchMemoriesTitleWhoDate')}
            className="w-full rounded-xl border border-border bg-surface/60 py-2 pl-9 pr-8 text-sm outline-none transition focus:border-brand/50"
          />
          {query && (
            <button onClick={() => setQuery('')} aria-label={t('memoryTimeline.clearSearch')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted hover:text-fg">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <button
          onClick={() => setFavoritesOnly((f) => !f)} aria-pressed={favoritesOnly}
          className={`flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-medium transition ${
            favoritesOnly ? 'border-amber-400/60 bg-amber-400/10 text-amber-500' : 'border-border bg-surface/60 text-muted hover:text-fg'
          }`}
        >
          <Star className={`h-3.5 w-3.5 ${favoritesOnly ? 'fill-amber-400' : ''}`} /> {t('memoryTimeline.favorites')}
        </button>
      </div>

      {filtered.length > 0 ? (
        <ul className="space-y-3">
          {filtered.map((m) => {
            const Icon = KIND_ICON[m.kind] ?? BookHeart;
            return (
              <li key={m.id} className="flex items-start gap-3 rounded-xl bg-surface/40 p-3">
                <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-violet-500/15">
                  <Icon className="h-4 w-4 text-brand-text" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-sm font-medium">{m.title}{m.is_favorite && <Star className="h-3.5 w-3.5 text-amber-400" />}</p>
                  {m.body && <p className="mt-0.5 line-clamp-2 text-xs text-muted">{m.body}</p>}
                  <p className="mt-1 text-xs text-muted">{[fmtDate(m.memory_date), m.member_id ? nameById[m.member_id] : null].filter(Boolean).join(' · ')}</p>
                </div>
                <DeleteButton table="family_memories" id={m.id} />
              </li>
            );
          })}
        </ul>
      ) : memories.length > 0 ? (
        <MiniEmpty icon={Search} text="No memories match your search." />
      ) : (
        <MiniEmpty icon={Camera} text="No memories yet — capture your first above." />
      )}
    </div>
  );
}
