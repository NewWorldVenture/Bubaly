'use client';

// "Post in under 60 seconds with AI" — the one-sentence listing composer
// (backlog #10). Type what you're selling the way you'd text a neighbor; the
// drafting engine (lib/marketplace/quick-post.ts — deterministic, instant, no
// key) fills the whole listing: kind, category, condition, price, pickup spot,
// a clean title and description. Everything stays editable; a price suggestion
// is computed from the family's own comparable listings; Post inserts straight
// into marketplace_listings. A live stopwatch keeps the 60-second promise
// honest.
import { useEffect, useRef, useState } from 'react';
import { Sparkles, Zap, Loader2, Wand2, X, Timer } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import {
  CATEGORY_LABELS, CONDITION_LABELS, KIND_LABELS, KIND_ORDER, dollarsToCents, kindHasPrice,
  type ListingCategory, type ListingCondition, type ListingKind,
} from '@/lib/marketplace/listings';
import { draftListing, suggestPriceCents, type Comparable, type QuickDraft } from '@/lib/marketplace/quick-post';
import { PhotoUpload } from '@/components/marketplace/photo-upload';
import { cn } from '@/lib/utils/cn';

const CATEGORIES = Object.keys(CATEGORY_LABELS) as ListingCategory[];
const CONDITIONS = Object.keys(CONDITION_LABELS) as ListingCondition[];

const MATCH_LABEL: Record<QuickDraft['matched'][number], string> = {
  kind: 'type', category: 'category', condition: 'condition', price: 'price', location: 'pickup',
};

export function QuickPost({ className }: { className?: string }) {
  const { familyId, userId, selfMember } = useApp();
  const { success, error: toastError } = useToast();

  const [input, setInput] = useState('');
  const [draft, setDraft] = useState<QuickDraft | null>(null);
  const [price, setPrice] = useState('');
  const [photo, setPhoto] = useState('');
  const [posting, setPosting] = useState(false);
  const [comps, setComps] = useState<Comparable[] | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // The stopwatch — starts on Draft, stops on Post/reset.
  useEffect(() => {
    if (startedAt == null) { if (timerRef.current) clearInterval(timerRef.current); return; }
    timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 500);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [startedAt]);

  // Comparables for the price suggestion — fetched once, lazily, best-effort.
  useEffect(() => {
    if (!draft || comps !== null) return;
    const sb = createClient();
    sb.from('marketplace_listings')
      .select('category, condition, price_cents, kind')
      .eq('family_id', familyId)
      .eq('kind', 'sell')
      .gt('price_cents', 0)
      .limit(400)
      .then(({ data }) => setComps((data ?? []) as Comparable[]));
  }, [draft, comps, familyId]);

  const makeDraft = () => {
    const text = input.trim();
    if (!text) { toastError('Describe the item first — one sentence is plenty'); return; }
    const d = draftListing(text);
    setDraft(d);
    setPrice(d.priceCents != null ? String(d.priceCents / 100) : '');
    setStartedAt((s) => s ?? Date.now());
  };

  const reset = () => {
    setDraft(null); setInput(''); setPrice(''); setPhoto(''); setStartedAt(null); setElapsed(0);
  };

  const suggested = draft && kindHasPrice(draft.kind)
    ? suggestPriceCents(draft.category, draft.condition, comps ?? [])
    : null;

  async function post() {
    if (!draft) return;
    if (!draft.title.trim()) { toastError('Give it a title'); return; }
    setPosting(true);
    const sb = createClient();
    const priced = kindHasPrice(draft.kind);
    const { error } = await sb.from('marketplace_listings').insert({
      family_id: familyId,
      member_id: selfMember?.id ?? null,
      created_by: userId,
      title: draft.title.trim(),
      description: draft.description.trim() || null,
      kind: draft.kind,
      category: draft.category,
      condition: draft.condition,
      price_cents: priced ? dollarsToCents(price) : 0,
      location: draft.location,
      photo_url: photo.trim() || null,
    });
    setPosting(false);
    if (error) { toastError(describeDbError(error)); return; }
    const secs = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : null;
    success(secs != null && secs <= 60 ? `Posted in ${secs}s ⚡` : 'Posted to the family marketplace');
    reset();
  }

  const set = <K extends keyof QuickDraft>(key: K, value: QuickDraft[K]) =>
    setDraft((d) => (d ? { ...d, [key]: value } : d));

  return (
    <section className={cn('rounded-2xl border border-brand/30 bg-gradient-to-br from-brand/[0.08] to-transparent p-4 sm:p-5', className)}>
      <div className="flex items-center gap-2">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand/15">
          <Zap className="h-5 w-5 text-brand-text" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-black sm:text-base">Post in 60 seconds</h2>
          <p className="text-xs text-muted">One sentence — AI drafts the whole listing.</p>
        </div>
        {startedAt != null && (
          <span className={cn(
            'inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-mono text-xs font-bold tabular-nums',
            elapsed <= 60 ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300',
          )}>
            <Timer className="h-3 w-3" /> {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
          </span>
        )}
      </div>

      {!draft ? (
        <form
          className="mt-3 flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => { e.preventDefault(); makeDraft(); }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            maxLength={300}
            placeholder={'e.g. "Selling Emma\'s barely-used balance bike, $40, pickup in the garage"'}
            className="h-11 min-w-0 flex-1 rounded-xl border border-border bg-bg px-3 text-sm outline-none placeholder:text-muted/70 focus:border-brand"
          />
          <button
            type="submit"
            className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-brand px-4 text-sm font-bold text-brand-fg transition hover:opacity-90"
          >
            <Wand2 className="h-4 w-4" /> Draft it
          </button>
        </form>
      ) : (
        <div className="mt-3 space-y-3">
          {/* What the AI detected */}
          {draft.matched.length > 0 && (
            <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
              <Sparkles className="h-3 w-3 text-brand-text" /> AI filled:
              {draft.matched.map((m) => (
                <span key={m} className="rounded-full bg-brand/10 px-2 py-0.5 font-semibold text-brand-text">{MATCH_LABEL[m]}</span>
              ))}
            </p>
          )}

          <input
            value={draft.title}
            onChange={(e) => set('title', e.target.value)}
            maxLength={80}
            aria-label="Title"
            className="h-11 w-full rounded-xl border border-border bg-bg px-3 text-sm font-semibold outline-none focus:border-brand"
          />

          <PhotoUpload value={photo} onChange={setPhoto} userId={userId} />

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <select
              value={draft.kind}
              onChange={(e) => set('kind', e.target.value as ListingKind)}
              aria-label="Listing type"
              className="h-10 rounded-xl border border-border bg-bg px-2 text-xs outline-none focus:border-brand"
            >
              {KIND_ORDER.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
            </select>
            <select
              value={draft.category}
              onChange={(e) => set('category', e.target.value as ListingCategory)}
              aria-label="Category"
              className="h-10 rounded-xl border border-border bg-bg px-2 text-xs outline-none focus:border-brand"
            >
              {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
            </select>
            <select
              value={draft.condition ?? ''}
              onChange={(e) => set('condition', (e.target.value || null) as ListingCondition | null)}
              aria-label="Condition"
              className="h-10 rounded-xl border border-border bg-bg px-2 text-xs outline-none focus:border-brand"
            >
              <option value="">Condition…</option>
              {CONDITIONS.map((c) => <option key={c} value={c}>{CONDITION_LABELS[c]}</option>)}
            </select>
            {kindHasPrice(draft.kind) ? (
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs text-muted">$</span>
                <input
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  inputMode="decimal"
                  aria-label="Price"
                  placeholder="0"
                  className="h-10 w-full rounded-xl border border-border bg-bg pl-6 pr-2 text-xs outline-none focus:border-brand"
                />
              </div>
            ) : (
              <span className="inline-flex h-10 items-center justify-center rounded-xl border border-dashed border-border text-[11px] text-muted">No price</span>
            )}
          </div>

          {suggested != null && kindHasPrice(draft.kind) && dollarsToCents(price) !== suggested && (
            <button
              type="button"
              onClick={() => setPrice(String(suggested / 100))}
              className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-[11px] font-bold text-emerald-300 ring-1 ring-emerald-400/30 transition hover:bg-emerald-500/20"
            >
              <Sparkles className="h-3 w-3" /> AI suggests ${suggested / 100} from your family&apos;s comparable listings
            </button>
          )}

          <textarea
            value={draft.description}
            onChange={(e) => set('description', e.target.value)}
            rows={2}
            maxLength={500}
            aria-label="Description"
            className="w-full rounded-xl border border-border bg-bg p-3 text-xs outline-none focus:border-brand"
          />

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={post}
              disabled={posting}
              className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-brand px-4 text-sm font-bold text-brand-fg transition hover:opacity-90 disabled:opacity-60 sm:flex-none sm:px-6"
            >
              {posting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />} Post now
            </button>
            <button
              type="button"
              onClick={reset}
              disabled={posting}
              className="inline-flex h-11 items-center gap-1.5 rounded-xl border border-border px-3 text-xs font-semibold text-muted transition hover:text-fg disabled:opacity-50"
            >
              <X className="h-3.5 w-3.5" /> Start over
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
