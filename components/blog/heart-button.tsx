'use client';

// The blog ♥ — now a SIGNED-IN save (bookmark). Clicking requires a Bubaly
// account: a signed-out reader is sent to sign in (and returned here), and a
// signed-in reader toggles a per-account save persisted in blog_post_saves.
// Optimistic: the heart fills and the count bumps instantly; the server
// response reconciles. Wired to /api/blog/save.
import { useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Heart } from 'lucide-react';
import { formatLikeCount } from '@/lib/blog/engagement';
import { cn } from '@/lib/utils/cn';

export function HeartButton({ slug, className }: { slug: string; className?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [saved, setSaved] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [pop, setPop] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/blog/save?slug=${encodeURIComponent(slug)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { saved?: boolean; count?: number; authenticated?: boolean } | null) => {
        if (cancelled || !d) return;
        setSaved(!!d.saved);
        setCount(typeof d.count === 'number' ? d.count : 0);
        setAuthed(!!d.authenticated);
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
    // Not signed in → send them to sign in (and back). This is the gate.
    if (authed === false) { goSignIn(); return; }

    setBusy(true);
    const wasSaved = saved;
    const prevCount = count ?? 0;
    // Optimistic flip
    setSaved(!wasSaved);
    setCount(Math.max(0, prevCount + (wasSaved ? -1 : 1)));
    if (!wasSaved) { setPop(true); setTimeout(() => setPop(false), 450); }
    try {
      const res = await fetch('/api/blog/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
      });
      if (res.status === 401) {
        // Session missing/expired — revert and route to sign in.
        setSaved(wasSaved);
        setCount(prevCount);
        setAuthed(false);
        goSignIn();
        return;
      }
      if (res.ok) {
        const d = (await res.json()) as { saved?: boolean; count?: number };
        setSaved(!!d.saved);
        setCount(typeof d.count === 'number' ? d.count : prevCount);
        setAuthed(true);
      } else {
        setSaved(wasSaved);
        setCount(prevCount);
      }
    } catch {
      setSaved(wasSaved);
      setCount(prevCount);
    } finally {
      setBusy(false);
    }
  }, [busy, authed, saved, count, slug, goSignIn]);

  const label = authed === false
    ? 'Sign in to save this article'
    : saved ? 'Remove this article from your saved list' : 'Save this article';

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={saved}
      aria-label={label}
      title={authed === false ? 'Sign in to save' : undefined}
      className={cn(
        'group inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold transition',
        saved
          ? 'border-rose-400/40 bg-rose-500/15 text-rose-300'
          : 'border-white/15 bg-white/[0.04] text-white/60 hover:border-rose-400/40 hover:text-rose-300',
        className,
      )}
    >
      <Heart
        className={cn(
          'h-4 w-4 transition-transform',
          saved && 'fill-rose-400 text-rose-400',
          pop && 'animate-heart-pop',
          !saved && 'group-hover:scale-110',
        )}
      />
      <span className="tabular-nums">{count == null ? '—' : formatLikeCount(count)}</span>
      <span className="sr-only">{saved ? 'saved' : 'saves'}</span>
    </button>
  );
}
