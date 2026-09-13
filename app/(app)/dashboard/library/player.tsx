'use client';
import { shouldPersistOnUnmount, resumeFrom, LIBRARY_CACHE } from '@/lib/library/progress';

import { useEffect, useRef, useState, useTransition } from 'react';
import { Play, Pause, Bookmark, BookmarkCheck, Download, RefreshCw, Trash2, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { formatDuration, progressPercent } from '@/lib/library/feed-parse';
import {
  addBookAction, refreshFeedAction, saveProgressAction, subscribeFeedAction, unsubscribeFeedAction,
} from './actions';

const inputCls = 'h-10 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm focus-ring';

/** How often a playing item writes its position back. */
const SAVE_EVERY_SECONDS = 15;

export type PlayableItem = {
  id: string;
  title: string;
  author: string | null;
  mediaUrl: string | null;
  pageUrl: string | null;
  durationSeconds: number | null;
  positionSeconds: number;
  saved: boolean;
  offline: boolean;
  /** Finished, so "play again" starts at the beginning rather than the credits. */
  completed: boolean;
};

/**
 * Where the bytes come from: Bubaly's own origin, not the publisher's.
 *
 * `cache.add()` fetches from the DOCUMENT context, so it answers to
 * `connect-src` — not `media-src`, which is why streaming from a CDN worked and
 * downloading from one never could. No podcast host is on this app's
 * connect-src allowlist, so every Download press failed with a CSP refusal.
 * A same-origin URL is permitted by `connect-src 'self'` as it stands, and it
 * also sidesteps CORS, since `cache.add` rejects an opaque response.
 */
function mediaHref(itemId: string): string {
  return `/library/media/${encodeURIComponent(itemId)}`;
}

export function ItemRow({ item }: { item: PlayableItem }) {
  const { success, error } = useToast();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastSaved = useRef(item.positionSeconds);
  // Whether this row's audio was actually played in this visit. See the unmount
  // effect below — without it, opening the page was enough to lose your place.
  const touched = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(item.positionSeconds);
  const [saved, setSaved] = useState(item.saved);
  const [offline, setOffline] = useState(item.offline);
  const [cached, setCached] = useState<boolean | null>(null);
  const [, start] = useTransition();

  // Whether the bytes are ACTUALLY cached, read from the Cache API rather than
  // inferred from the flag. The flag is what the person asked for; this is what
  // is true, and the row shows the second.
  useEffect(() => {
    let alive = true;
    if (!item.mediaUrl || typeof caches === 'undefined') { setCached(false); return () => { alive = false; }; }
    caches.match(mediaHref(item.id))
      .then((hit) => { if (alive) setCached(Boolean(hit)); })
      .catch(() => { if (alive) setCached(false); });
    return () => { alive = false; };
  }, [item.mediaUrl, item.id]);

  // Write the position on unmount as well as on the interval, so closing the
  // tab mid-episode does not lose the last stretch of listening.
  //
  // `touched` is what makes that safe. `lastSaved` starts at the position the
  // person had already reached, while an <audio> element that has never been
  // played reports currentTime 0 — so for every part-listened episode on the
  // page, the difference was the whole of their progress and unmount wrote a 0
  // over it. Opening the library and walking away was enough to lose every
  // bookmark in the house, silently, and the next visit started them at the top
  // of each episode with nothing to say why.
  useEffect(() => () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!shouldPersistOnUnmount({
      touched: touched.current, currentTime: audio.currentTime, lastSaved: lastSaved.current,
    })) return;
    void saveProgressAction({ itemId: item.id, positionSeconds: Math.floor(audio.currentTime) });
  }, [item.id]);

  function toggle() {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      // Resume where this person left off, not where the last person did.
      if (audio.currentTime < 1) audio.currentTime = resumeFrom(item);
      touched.current = true;
      void audio.play().then(() => setPlaying(true)).catch(() => error('That audio could not be played.'));
    } else {
      audio.pause();
      setPlaying(false);
      void saveProgressAction({ itemId: item.id, positionSeconds: Math.floor(audio.currentTime) });
    }
  }

  function onTimeUpdate() {
    const audio = audioRef.current;
    if (!audio) return;
    setPosition(audio.currentTime);
    touched.current = true;
    if (audio.currentTime - lastSaved.current >= SAVE_EVERY_SECONDS) {
      lastSaved.current = audio.currentTime;
      void saveProgressAction({ itemId: item.id, positionSeconds: Math.floor(audio.currentTime) });
    }
  }

  function toggleSaved() {
    const next = !saved;
    setSaved(next);
    start(async () => {
      const result = await saveProgressAction({ itemId: item.id, saved: next });
      if (!result.ok) { setSaved(!next); error(result.error); }
    });
  }

  async function toggleOffline() {
    const next = !offline;
    setOffline(next);
    start(async () => {
      const result = await saveProgressAction({ itemId: item.id, offline: next });
      if (!result.ok) { setOffline(!next); error(result.error); return; }
      if (!item.mediaUrl || typeof caches === 'undefined') {
        // Say so rather than showing a tick over nothing.
        error('This browser cannot store audio offline.');
        setCached(false);
        return;
      }
      const href = mediaHref(item.id);
      try {
        const cache = await caches.open(LIBRARY_CACHE);
        if (next) { await cache.add(href); setCached(true); success('Saved for offline.'); }
        else { await cache.delete(href); setCached(false); success('Removed from offline.'); }
      } catch {
        setCached(false);
        // The flag was written before the bytes were fetched, and used to stay
        // written when the fetch failed — so the row claimed a download that
        // did not exist and the tick asserted it. Put it back.
        if (next) void saveProgressAction({ itemId: item.id, offline: false }).then(() => setOffline(false));
        error(next ? 'That file could not be stored offline.' : 'That file could not be removed.');
      }
    });
  }

  const percent = progressPercent(position, item.durationSeconds);
  return (
    <li className="rounded-2xl border border-border bg-surface/40 p-3">
      <div className="flex items-start gap-3">
        {item.mediaUrl && (
          <Button size="sm" variant="secondary" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
            {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </Button>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{item.title}</p>
          <p className="text-xs text-muted">
            {[item.author, formatDuration(item.durationSeconds)].filter(Boolean).join(' · ') || '—'}
            {percent > 0 && ` · ${percent}% through`}
          </p>
          {percent > 0 && (
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-elevated">
              <div className="h-full rounded-full bg-brand" style={{ width: `${percent}%` }} />
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="ghost" onClick={toggleSaved} aria-label={saved ? 'Remove from saved' : 'Save'}>
            {saved ? <BookmarkCheck className="h-4 w-4 text-brand-text" /> : <Bookmark className="h-4 w-4" />}
          </Button>
          {item.mediaUrl && (
            <Button size="sm" variant="ghost" onClick={() => void toggleOffline()}
              aria-label={offline ? 'Remove download' : 'Save for offline'}>
              <Download className={`h-4 w-4 ${cached ? 'text-success' : ''}`} />
            </Button>
          )}
          {item.pageUrl && (
            <a href={item.pageUrl} target="_blank" rel="noreferrer noopener"
              className="rounded-lg p-2 text-muted hover:text-fg" aria-label="Open page">
              <ExternalLink className="h-4 w-4" />
            </a>
          )}
        </div>
      </div>
      {item.mediaUrl && (
        <audio ref={audioRef} src={mediaHref(item.id)} preload="none" onTimeUpdate={onTimeUpdate}
          onEnded={() => { setPlaying(false); void saveProgressAction({ itemId: item.id, completed: true }); }} />
      )}
      {offline && cached === false && (
        <p className="mt-1.5 text-xs text-warning">Marked for offline, but not stored on this device yet.</p>
      )}
    </li>
  );
}

export function SubscribeForm() {
  const { success, error } = useToast();
  const [pending, start] = useTransition();
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const data = new FormData(form);
        start(async () => {
          const result = await subscribeFeedAction(data);
          if (result.ok) { success(result.message); form.reset(); } else error(result.error);
        });
      }}
    >
      <label className="block text-sm">
        <span className="mb-1 block font-medium">Feed address</span>
        <input name="url" className={inputCls} placeholder="https://example.com/feed.xml" required />
        <span className="mt-1 block text-xs text-muted">
          Any public podcast or audiobook RSS feed. Bubaly keeps the listing and streams from the publisher.
        </span>
      </label>
      <label className="block text-sm">
        <span className="mb-1 block font-medium">Kind</span>
        <select name="kind" className={inputCls} defaultValue="podcast">
          <option value="podcast">Podcast</option>
          <option value="book">Audiobook</option>
        </select>
      </label>
      <Button type="submit" loading={pending} className="w-full">Subscribe</Button>
    </form>
  );
}

export function AddBookForm() {
  const { success, error } = useToast();
  const [pending, start] = useTransition();
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const data = new FormData(form);
        start(async () => {
          const result = await addBookAction(data);
          if (result.ok) { success(result.message); form.reset(); } else error(result.error);
        });
      }}
    >
      <label className="block text-sm">
        <span className="mb-1 block font-medium">Title</span>
        <input name="title" className={inputCls} required />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block font-medium">Author</span>
        <input name="author" className={inputCls} />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block font-medium">Link <span className="text-muted">(optional)</span></span>
        <input name="pageUrl" type="url" className={inputCls} placeholder="https://…" />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block font-medium">Audio file <span className="text-muted">(optional)</span></span>
        <input name="mediaUrl" type="url" className={inputCls} placeholder="https://…/book.mp3" />
      </label>
      <Button type="submit" loading={pending} className="w-full">Add to library</Button>
    </form>
  );
}

export function FeedControls({ id }: { id: string }) {
  const { success, error } = useToast();
  const [pending, start] = useTransition();
  const run = (work: () => Promise<{ ok: true; message: string } | { ok: false; error: string }>) =>
    start(async () => {
      const result = await work();
      if (result.ok) success(result.message); else error(result.error);
    });
  return (
    <div className="flex gap-1">
      <Button size="sm" variant="ghost" loading={pending} onClick={() => run(() => refreshFeedAction(id))}>
        <RefreshCw className="h-4 w-4" /> Refresh
      </Button>
      <Button size="sm" variant="ghost" loading={pending} onClick={() => run(() => unsubscribeFeedAction(id))}>
        <Trash2 className="h-4 w-4" /> Remove
      </Button>
    </div>
  );
}
