'use client';

// The blog ♥ — an anonymous, one-per-visitor like keyed by the durable
// bubaly_vid id (no account needed on a public marketing page). Optimistic:
// the heart fills and the count bumps instantly; the server response
// reconciles. Wired to /api/blog/like (Supabase blog_post_likes underneath).
import { useCallback, useEffect, useState } from 'react';
import { Heart } from 'lucide-react';
import { getAnonymousId } from '@/lib/marketing/visitor';
import { formatLikeCount } from '@/lib/blog/engagement';
import { cn } from '@/lib/utils/cn';

export function HeartButton({ slug, className }: { slug: string; className?: string }) {
  const [liked, setLiked] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [pop, setPop] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const visitorId = getAnonymousId();
    fetch(`/api/blog/like?slug=${encodeURIComponent(slug)}&visitorId=${encodeURIComponent(visitorId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { liked?: boolean; count?: number } | null) => {
        if (cancelled || !d) return;
        setLiked(!!d.liked);
        setCount(typeof d.count === 'number' ? d.count : 0);
      })
      .catch(() => { /* leave the button usable with no count */ });
    return () => { cancelled = true; };
  }, [slug]);

  const toggle = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    const wasLiked = liked;
    const prevCount = count ?? 0;
    // Optimistic flip
    setLiked(!wasLiked);
    setCount(Math.max(0, prevCount + (wasLiked ? -1 : 1)));
    if (!wasLiked) { setPop(true); setTimeout(() => setPop(false), 450); }
    try {
      const res = await fetch('/api/blog/like', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, visitorId: getAnonymousId() }),
      });
      if (res.ok) {
        const d = (await res.json()) as { liked?: boolean; count?: number };
        setLiked(!!d.liked);
        setCount(typeof d.count === 'number' ? d.count : prevCount);
      } else {
        setLiked(wasLiked);
        setCount(prevCount);
      }
    } catch {
      setLiked(wasLiked);
      setCount(prevCount);
    } finally {
      setBusy(false);
    }
  }, [busy, liked, count, slug]);

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={liked}
      aria-label={liked ? 'Remove your like from this article' : 'Like this article'}
      className={cn(
        'group inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold transition',
        liked
          ? 'border-rose-400/40 bg-rose-500/15 text-rose-300'
          : 'border-white/15 bg-white/[0.04] text-white/60 hover:border-rose-400/40 hover:text-rose-300',
        className,
      )}
    >
      <Heart
        className={cn(
          'h-4 w-4 transition-transform',
          liked && 'fill-rose-400 text-rose-400',
          pop && 'animate-heart-pop',
          !liked && 'group-hover:scale-110',
        )}
      />
      <span className="tabular-nums">{count == null ? '—' : formatLikeCount(count)}</span>
      <span className="sr-only">{liked ? 'liked' : 'likes'}</span>
    </button>
  );
}
