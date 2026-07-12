'use client';

// Community Circles — the cross-family marketplace surface (backlog #21 v1).
// Mobile-first: create/join by invite code, pick a circle, share your own
// available listings into it, and browse what other families shared. Reads are
// server-loaded (RLS does the cross-family work); writes go through the
// circle actions and revalidate.
import { useMemo, useState, useTransition } from 'react';
import {
  Users, Plus, LogOut, Copy, Loader2, Share2, X, HandHeart, Sparkles,
} from 'lucide-react';
import {
  buildCircleFeed, circleStats, formatJoinCode, shareableListings,
  type CircleLite, type CircleMemberLite, type ShareLite, type SharedListingLite,
} from '@/lib/marketplace/community';
import {
  createCircleAction, joinCircleAction, leaveCircleAction,
  shareListingAction, unshareListingAction,
} from '@/app/(app)/marketplace/community/actions';
import { KIND_LABELS, CONDITION_LABELS, CATEGORY_LABELS, priceLabel, type ListingKind, type ListingCategory, type ListingCondition, type RentPeriod } from '@/lib/marketplace/listings';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';

export function CommunityModule({
  migrated, familyId, circles, members, shares, sharedListings, myListings,
}: {
  migrated: boolean;
  familyId: string;
  circles: CircleLite[];
  members: CircleMemberLite[];
  shares: ShareLite[];
  sharedListings: SharedListingLite[];
  myListings: SharedListingLite[];
}) {
  const { success, error: toastError } = useToast();
  const [selected, setSelected] = useState<string | null>(circles[0]?.id ?? null);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [shareId, setShareId] = useState('');
  const [pending, startTransition] = useTransition();

  const circle = circles.find((c) => c.id === selected) ?? null;
  const feed = useMemo(
    () => (circle ? buildCircleFeed(circle.id, shares, sharedListings, members, familyId) : []),
    [circle, shares, sharedListings, members, familyId],
  );
  const stats = circle ? circleStats(circle.id, members, feed) : null;
  const myRole = circle ? members.find((m) => m.circle_id === circle.id && m.family_id === familyId)?.role : null;
  const shareable = circle ? shareableListings(myListings, familyId, circle.id, shares) : [];

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, okMsg: string) =>
    startTransition(async () => {
      const res = await fn();
      if (res.ok) success(okMsg);
      else toastError((res as { error: string }).error);
    });

  const copyCode = async (c: string) => {
    try { await navigator.clipboard.writeText(formatJoinCode(c)); success('Invite code copied'); }
    catch { toastError('Could not copy'); }
  };

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-black sm:text-3xl">
          <Users className="h-6 w-6 text-brand" /> Community Circles
        </h1>
        <p className="mt-1 max-w-xl text-sm text-muted">
          Share listings beyond your household — the class, the team, the street.
          Only what a family chooses to share is visible, and only inside that circle.
        </p>
      </header>

      {!migrated && (
        <p className="mt-4 rounded-2xl border border-amber-400/30 bg-amber-500/[0.06] p-4 text-xs text-amber-300">
          Circles aren&apos;t enabled on this database yet — apply migration <code>0173_marketplace_circles.sql</code> and refresh.
        </p>
      )}

      {/* Create + join */}
      <section className="mt-5 grid gap-3 sm:grid-cols-2">
        <form
          className="flex items-center gap-2 rounded-2xl border border-border bg-surface p-3"
          onSubmit={(e) => { e.preventDefault(); if (name.trim()) { run(() => createCircleAction(name), 'Circle created — share the invite code'); setName(''); } }}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            placeholder="Start a circle (e.g. Maple Street)"
            className="h-10 min-w-0 flex-1 rounded-xl border border-border bg-bg px-3 text-sm outline-none focus:border-brand"
          />
          <button type="submit" disabled={pending || !migrated}
            className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl bg-brand px-3.5 text-sm font-bold text-brand-fg transition hover:opacity-90 disabled:opacity-50">
            <Plus className="h-4 w-4" /> Create
          </button>
        </form>
        <form
          className="flex items-center gap-2 rounded-2xl border border-border bg-surface p-3"
          onSubmit={(e) => { e.preventDefault(); if (code.trim()) { run(() => joinCircleAction(code), 'Joined the circle 🎉'); setCode(''); } }}
        >
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            maxLength={9}
            placeholder="Join with a code (ABCD-EFGH)"
            className="h-10 min-w-0 flex-1 rounded-xl border border-border bg-bg px-3 font-mono text-sm uppercase outline-none focus:border-brand"
          />
          <button type="submit" disabled={pending || !migrated}
            className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl border border-brand/40 px-3.5 text-sm font-bold text-brand transition hover:bg-brand/10 disabled:opacity-50">
            Join
          </button>
        </form>
      </section>

      {/* Circle picker */}
      {circles.length > 0 && (
        <nav className="mt-5 flex flex-wrap gap-2">
          {circles.map((c) => (
            <button
              key={c.id}
              onClick={() => setSelected(c.id)}
              className={cn(
                'inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-xs font-bold transition',
                selected === c.id ? 'border-brand bg-brand/15 text-brand' : 'border-border text-muted hover:bg-elevated',
              )}
            >
              <span aria-hidden>{c.emoji}</span> {c.name}
            </button>
          ))}
        </nav>
      )}

      {/* Selected circle */}
      {circle && stats ? (
        <section className="mt-4 space-y-4">
          <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-surface p-4">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold">{circle.emoji} {circle.name}</p>
              <p className="text-xs text-muted">
                {stats.families} famil{stats.families === 1 ? 'y' : 'ies'} · {stats.shared} shared item{stats.shared === 1 ? '' : 's'} · {stats.fromOthers} from others
              </p>
            </div>
            <button
              type="button"
              onClick={() => void copyCode(circle.join_code)}
              className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-border px-3 font-mono text-xs font-bold transition hover:bg-elevated"
              title="Copy the invite code"
            >
              <Copy className="h-3.5 w-3.5" /> {formatJoinCode(circle.join_code)}
            </button>
            <button
              type="button"
              onClick={() => {
                const owner = myRole === 'owner';
                if (confirm(owner ? 'You founded this circle — leaving dissolves it for everyone. Continue?' : `Leave ${circle.name}?`)) {
                  run(() => leaveCircleAction(circle.id), owner ? 'Circle dissolved' : 'Left the circle');
                  setSelected(null);
                }
              }}
              disabled={pending}
              className="inline-flex h-9 items-center gap-1.5 rounded-xl px-3 text-xs font-semibold text-muted transition hover:text-rose-400 disabled:opacity-50"
            >
              <LogOut className="h-3.5 w-3.5" /> {myRole === 'owner' ? 'Dissolve' : 'Leave'}
            </button>
          </div>

          {/* Share picker */}
          <div className="flex flex-col gap-2 rounded-2xl border border-brand/25 bg-brand/[0.04] p-3 sm:flex-row sm:items-center">
            <Share2 className="hidden h-4 w-4 shrink-0 text-brand sm:block" />
            <select
              value={shareId}
              onChange={(e) => setShareId(e.target.value)}
              aria-label="Pick one of your listings to share"
              className="h-10 min-w-0 flex-1 rounded-xl border border-border bg-bg px-3 text-sm outline-none focus:border-brand"
            >
              <option value="">Share one of your listings into this circle…</option>
              {shareable.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.title}{l.price_cents ? ` — ${priceLabel(l.kind as ListingKind, l.price_cents, (l.rent_period ?? null) as RentPeriod | null)}` : ''}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={pending || !shareId}
              onClick={() => { run(() => shareListingAction(shareId, circle.id), 'Shared with the circle'); setShareId(''); }}
              className="inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-xl bg-brand px-4 text-sm font-bold text-brand-fg transition hover:opacity-90 disabled:opacity-50"
            >
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4" />} Share
            </button>
          </div>

          {/* Feed */}
          {feed.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border p-8 text-center">
              <HandHeart className="mx-auto h-8 w-8 text-muted" />
              <p className="mt-2 text-sm font-semibold">Nothing shared yet</p>
              <p className="mt-1 text-xs text-muted">Share the first item above, or nudge the other families with the invite code.</p>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {feed.map((f) => (
                <article key={`${f.circleId}-${f.listing.id}`} className="rounded-2xl border border-border bg-surface p-4">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="rounded-md bg-brand/12 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand">
                      {KIND_LABELS[f.listing.kind as ListingKind] ?? f.listing.kind}
                    </span>
                    <span className="rounded-full bg-elevated px-2 py-0.5 text-[10px] font-bold text-muted">
                      {CATEGORY_LABELS[f.listing.category as ListingCategory] ?? f.listing.category}
                    </span>
                    {f.listing.condition && (
                      <span className="text-[10px] text-muted">{CONDITION_LABELS[f.listing.condition as ListingCondition] ?? f.listing.condition}</span>
                    )}
                  </div>
                  <p className="mt-1.5 text-sm font-bold leading-snug">{f.listing.title}</p>
                  <p className="mt-0.5 text-sm font-semibold text-brand">
                    {priceLabel(f.listing.kind as ListingKind, f.listing.price_cents ?? 0, (f.listing.rent_period ?? null) as RentPeriod | null) || '—'}
                  </p>
                  <div className="mt-2 flex items-center gap-2 border-t border-border/50 pt-2">
                    <p className="min-w-0 flex-1 truncate text-[11px] text-muted">
                      {f.isMine ? 'Shared by your family' : <>From <span className="font-semibold text-fg">{f.fromFamily}</span> — message them to arrange it</>}
                    </p>
                    {f.isMine && (
                      <button
                        type="button"
                        onClick={() => run(() => unshareListingAction(f.listing.id, f.circleId), 'Removed from the circle')}
                        disabled={pending}
                        title="Stop sharing"
                        className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-muted transition hover:text-rose-400 disabled:opacity-50"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      ) : (
        migrated && circles.length === 0 && (
          <div className="mt-6 rounded-2xl border border-dashed border-border p-8 text-center">
            <Sparkles className="mx-auto h-8 w-8 text-brand/60" />
            <p className="mt-2 text-sm font-semibold">Your family isn&apos;t in a circle yet</p>
            <p className="mx-auto mt-1 max-w-sm text-xs text-muted">
              Start one for your street, class or team and share the invite code — or paste a code a friend sent you.
            </p>
          </div>
        )
      )}
    </div>
  );
}
