'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { Search, Plus, Check, ChefHat, Loader2, ArrowLeft } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { saveDiscoveredRecipe } from './actions';
import { describeDbError } from '@/lib/supabase/errors';

type Result = {
  sourceProvider: string; sourceRecipeId: string; sourceUrl: string | null;
  attribution: string; name: string; category: string; cuisine: string | null;
  photoUrl: string | null; tags: string[];
  ingredients: { name: string }[]; instructions: { step: number }[];
};

export function DiscoverClient() {
  const { success, error: toastError } = useToast();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Result[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function run(e: React.FormEvent) {
    e.preventDefault();
    const query = q.trim();
    if (!query) return;
    setSearching(true);
    setResults(null);
    try {
      const res = await fetch(`/api/recipes/search?q=${encodeURIComponent(query)}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Search failed');
      setResults(json.recipes ?? []);
    } catch (err) {
      toastError(describeDbError(err, 'Search failed'));
      setResults([]);
    } finally {
      setSearching(false);
    }
  }

  function save(r: Result) {
    const key = `${r.sourceProvider}:${r.sourceRecipeId}`;
    setSavingId(key);
    startTransition(async () => {
      const res = await saveDiscoveredRecipe({ provider: r.sourceProvider, sourceRecipeId: r.sourceRecipeId });
      setSavingId(null);
      if (res.ok) { setSaved((s) => ({ ...s, [key]: true })); success(res.already ? 'Already in your vault' : 'Saved to your family vault'); }
      else toastError(res.error);
    });
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/recipes" className="text-muted hover:text-fg"><ArrowLeft className="h-5 w-5" /></Link>
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold"><ChefHat className="h-5 w-5 text-brand" /> Discover Recipes</h1>
          <p className="text-sm text-muted">Search free recipe libraries and save favorites to your family vault.</p>
        </div>
      </div>

      <form onSubmit={run} className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            value={q} onChange={(e) => setQ(e.target.value)} autoFocus
            placeholder="Try “chicken”, “tacos”, “pasta”…"
            className="h-11 w-full rounded-xl border border-border bg-bg pl-10 pr-3 text-sm outline-none focus:border-brand"
          />
        </div>
        <button type="submit" disabled={searching} className="rounded-xl bg-brand px-5 text-sm font-semibold text-white hover:bg-brand/90 disabled:opacity-60">
          {searching ? 'Searching…' : 'Search'}
        </button>
      </form>

      {searching && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-56 animate-pulse rounded-2xl bg-elevated/40" />)}
        </div>
      )}

      {!searching && results && results.length === 0 && (
        <div className="rounded-2xl border border-dashed border-border py-16 text-center text-muted">No recipes found — try another search.</div>
      )}

      {!searching && results && results.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {results.map((r) => {
            const key = `${r.sourceProvider}:${r.sourceRecipeId}`;
            const isSaved = saved[key];
            return (
              <div key={key} className="flex flex-col overflow-hidden rounded-2xl border border-border bg-surface/40">
                {r.photoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={r.photoUrl} alt={r.name} className="h-32 w-full object-cover" loading="lazy" />
                ) : (
                  <div className="grid h-32 w-full place-items-center bg-elevated/40 text-3xl">🍽️</div>
                )}
                <div className="flex flex-1 flex-col p-3">
                  <p className="line-clamp-2 text-sm font-semibold">{r.name}</p>
                  <p className="mt-0.5 text-xs text-muted">{[r.cuisine, r.category].filter(Boolean).join(' · ')}</p>
                  <p className="mt-1 text-[11px] text-muted">{r.ingredients.length} ingredients · {r.instructions.length} steps</p>
                  <div className="mt-auto pt-2">
                    <button
                      onClick={() => save(r)} disabled={isSaved || savingId === key}
                      className={`flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${isSaved ? 'bg-emerald-500/15 text-emerald-300' : 'bg-brand text-white hover:bg-brand/90'} disabled:opacity-70`}
                    >
                      {savingId === key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : isSaved ? <Check className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                      {isSaved ? 'Saved' : 'Save to vault'}
                    </button>
                    <p className="mt-1 text-center text-[10px] text-muted">{r.attribution}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!searching && !results && (
        <div className="rounded-2xl border border-dashed border-border py-16 text-center text-muted">
          Search thousands of free recipes and build your family vault.
        </div>
      )}
    </div>
  );
}
