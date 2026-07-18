'use client';

// The blog ♥ — save an article to your account. Saving REQUIRES sign-in: a
// signed-out visitor who taps the heart is sent to /login?redirect=<article>
// so they return here afterward. Signed-in likes are one-per-account (keyed to
// the user id server-side) and optimistic: the heart fills and the count bumps
// instantly, then the server response reconciles. Wired to /api/blog/like
// (Supabase blog_post_likes underneath, service-role writes, session-gated).
import { useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Heart } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { getAnonymousId } from '@/lib/marketing/visitor';
import { formatLikeCount } from '@/lib/blog/engagement';
import { cn } from '@/lib/utils/cn';

export function HeartButton({ slug, className }: { slug: string; className?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [liked, setLiked] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [pop, setPop] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/blog/like?slug=${encodeURIComponent(slug)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { liked?: boolean; count?: number; signedIn?: boolean } | null) => {
        if (cancelled || !d) return;
        setLiked(!!d.liked);
        setCount(typeof d.count === 'number' ? d.count : 0);
        setSignedIn(!!d.signedIn);
      })
      .catch(() => { /* leave the button usable with no count */ });
    return () => { cancelled = true; };
  }, [slug]);

  const goSignIn = useCallback(() => {
    const dest = pathname || `/blog/${slug}`;
    router.push(`/login?redirect=${encodeURIComponent(dest)}`);
  }, [router, pathname, slug]);

  const toggle = useCallback(async () => {
    if (busy) return;
    // Gate: must be signed in to save. If we already know they're signed out,
    // send them straight to sign in.
    if (signedIn === false) {
      goSignIn();
      return;
    }
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
      if (res.status === 401) {
        // Session missing/expired — revert and send them to sign in.
        setLiked(wasLiked);
        setCount(prevCount);
        setSignedIn(false);
        goSignIn();
        return;
      }
      if (res.ok) {
        const d = (await res.json()) as { liked?: boolean; count?: number; signedIn?: boolean };
        setLiked(!!d.liked);
        setCount(typeof d.count === 'number' ? d.count : prevCount);
        setSignedIn(true);
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
  }, [busy, signedIn, liked, count, slug, goSignIn]);

  const label = signedIn === false
    ? 'Sign in to save this article'
    : liked
      ? 'Remove your like from this article'
      : 'Save this article';

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={liked}
      aria-label={label}
      title={label}
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
