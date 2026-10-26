'use client';
import {
  shouldPersistOnUnmount, resumeFrom, claimPlayback, releasePlayback, isOfflineAudio, LIBRARY_CACHE,
} from '@/lib/library/progress';

import { useEffect, useRef, useState, useTransition } from 'react';
import { Play, Pause, Bookmark, BookmarkCheck, Download, RefreshCw, Trash2, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslations } from '@/components/i18n/locale-provider';
import { useToast } from '@/components/ui/toast';
import { formatDuration, progressPercent } from '@/lib/library/feed-parse';
import {
  addBookAction, refreshFeedAction, saveProgressAction, subscribeFeedAction, unsubscribeFeedAction,
} from './actions';
import { safeWebLink } from '@/lib/utils/safe-link';

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
  /**
   * This person's places could not be read, so `positionSeconds` is not their
   * place — it is a 0 standing in for one. Nothing writes a position then: a
   * pause, or fifteen seconds of playback, would put that 0's neighbourhood
   * over the place they really have, with no way back.
   */
  progressUnknown?: boolean;
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

/**
 * A progress write nobody waits for. Each of these used to be
 * `void saveProgressAction(...)`: a refused write (`ok: false`) and a failed
 * call (a rejection) both vanished. `onFail` lets the caller take back what it
 * assumed — for the position saves, that `lastSaved` already held the unsaved
 * position, which is the number the unmount check trusts to decide there is
 * nothing left to save. Audit C1-S9-74.
 */
function saveInBackground(
  writes: { current: Promise<void> },
  input: Parameters<typeof saveProgressAction>[0], onFail?: () => void, onSaved?: () => void,
): void {
  // One row's writes go one at a time, each after the last has settled, so they
  // are stored in the order they were made. Sent together, a replay's
  // `completed: false` could be applied after the `completed: true` its own
  // `ended` wrote — and the finished item read as unfinished.
  writes.current = writes.current.then(() => saveProgressAction(input)
    .then((res) => {
      if (res.ok) { onSaved?.(); return; }
      console.warn('[library] background progress save refused', res.error);
      onFail?.();
    })
    .catch((err: unknown) => {
      console.warn('[library] background progress save failed', err);
      onFail?.();
    }));
}

export function ItemRow({ item }: { item: PlayableItem }) {
  const { success, error } = useToast();
  const t = useTranslations();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastSaved = useRef(item.positionSeconds);
  // Whether this row's audio was actually played in this visit. See the unmount
  // effect below — without it, opening the page was enough to lose your place.
  const touched = useRef(false);
  // Whether the stored row still says "finished". A replay of a finished item
  // has to say it is not any more, or every later visit starts it at 0:00 — a
  // finished row resumes from the top (resumeFrom) and nothing else cleared it.
  // It turns false only once a write saying so has landed.
  const finished = useRef(item.completed);
  // How many times the element has reached its end. A reset that lands after
  // a later `ended` must not un-finish what that end finished again.
  const endings = useRef(0);
  // Played while this person's place could not be read, so where the element
  // stands is not their place. The page can learn it mid-play — a Save or a
  // Download revalidates it, and this same row gets the real numbers — and
  // from then on a pause or fifteen seconds of playback would write the
  // stand-in position over the place just recovered. Nothing it reaches is
  // written; the next Play starts from the recovered place, and saves resume
  // from there.
  const provisional = useRef(false);
  const knewPlace = useRef(!item.progressUnknown);
  // This row's progress writes, in order (see saveInBackground).
  const writes = useRef<Promise<void>>(Promise.resolve());
  const shortOfTheEnd = (at: number) => !item.durationSeconds || at < item.durationSeconds - 5;
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
      .then(async (hit) => {
        // Kept before the library held only audio: a video, or bytes their
        // publisher never named. The worker no longer serves those (see
        // isOfflineAudio), so the row does not show them as downloaded, and
        // their space is given back.
        if (hit && !isOfflineAudio(hit.headers.get('content-type'))) {
          await caches.open(LIBRARY_CACHE).then((cache) => cache.delete(mediaHref(item.id))).catch(() => false);
          if (alive) setCached(false);
          return;
        }
        if (alive) setCached(Boolean(hit));
      })
      .catch(() => { if (alive) setCached(false); });
    return () => { alive = false; };
  }, [item.mediaUrl, item.id]);

  // The place arriving after the row first rendered without it: take it up,
  // or the refs keep the 0 that stood in for it (and a finished item's replay
  // would never say it is not finished any more).
  useEffect(() => {
    if (item.progressUnknown || knewPlace.current) return;
    knewPlace.current = true;
    finished.current = item.completed;
    if (!provisional.current) {
      lastSaved.current = item.positionSeconds;
      setPosition(item.positionSeconds);
    }
  }, [item.progressUnknown, item.positionSeconds, item.completed]);

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
    if (!audio || item.progressUnknown || provisional.current) return;
    if (!shouldPersistOnUnmount({
      touched: touched.current, currentTime: audio.currentTime, lastSaved: lastSaved.current,
    })) return;
    const end = item.durationSeconds;
    const unfinish = finished.current && (!end || audio.currentTime < end - 5);
    saveInBackground(writes, { itemId: item.id, positionSeconds: Math.floor(audio.currentTime), ...(unfinish ? { completed: false } : {}) });
  }, [item.id, item.progressUnknown, item.durationSeconds]);

  function toggle() {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      // Resume where this person left off, not where the last person did. What
      // was last saved is where playback starts from now: a finished item
      // restarts at 0 while its stored position is still the end, and measured
      // from there the fifteen-second saves never came.
      if (audio.currentTime < 1 || (provisional.current && !item.progressUnknown)) {
        const from = resumeFrom(item);
        audio.currentTime = from;
        lastSaved.current = from;
        provisional.current = false;
      }
      if (item.progressUnknown) provisional.current = true;
      touched.current = true;
      // Stop whatever else was playing BEFORE asking this one to start, so the
      // two never overlap even for the moment the promise takes to settle.
      claimPlayback(audio);
      void audio.play().catch(() => {
        releasePlayback(audio);
        error('That audio could not be played.');
      });
    } else {
      audio.pause();
    }
  }

  // `playing` follows the ELEMENT, not the click. A row can stop for reasons
  // this component never hears about — another row claiming playback, the
  // browser interrupting for a call, the operating system's media controls —
  // and a button that only tracked its own clicks showed Pause over silence.
  function onPlay() {
    const audio = audioRef.current;
    if (audio) claimPlayback(audio);
    if (item.progressUnknown) provisional.current = true;
    touched.current = true;
    setPlaying(true);
  }

  function onPause() {
    const audio = audioRef.current;
    setPlaying(false);
    if (!audio) return;
    releasePlayback(audio);
    // Whatever stopped it, this is where they got to.
    if (touched.current) savePosition(audio.currentTime);
  }

  // Claims the position as saved, and takes the claim back if the write does
  // not land — unless a later save has claimed a newer one meanwhile.
  function savePosition(at: number) {
    if (item.progressUnknown || provisional.current) return;
    const previous = lastSaved.current;
    lastSaved.current = at;
    // Playing a finished item again, short of its end, un-finishes it. At the
    // end itself it stays finished: the pause the element fires there comes
    // just before `ended`, and must not race it.
    //
    // The row stays "finished" here until a write saying otherwise LANDS, so
    // every save until then carries the reset too. Clearing it as the first
    // write was sent let a second, position-only save land while the first
    // failed: the stored row stayed finished, and the next visit restarted the
    // replay at 0:00 with its position thrown away.
    const replay = finished.current && shortOfTheEnd(at);
    const ending = endings.current;
    saveInBackground(writes, { itemId: item.id, positionSeconds: Math.floor(at), ...(replay ? { completed: false } : {}) }, () => {
      if (lastSaved.current === at) lastSaved.current = previous;
    }, () => {
      if (replay && endings.current === ending) finished.current = false;
    });
  }

  function onEnded() {
    endings.current += 1;
    finished.current = true;
    // Reaching the end from a stand-in start is not this person's place
    // either: the page told them nothing played now is saved as their place.
    if (item.progressUnknown || provisional.current) return;
    saveInBackground(writes, { itemId: item.id, completed: true });
  }

  function onTimeUpdate() {
    const audio = audioRef.current;
    if (!audio) return;
    setPosition(audio.currentTime);
    if (item.progressUnknown) provisional.current = true;
    touched.current = true;
    if (audio.currentTime - lastSaved.current >= SAVE_EVERY_SECONDS) savePosition(audio.currentTime);
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
      let notAudio = false;
      try {
        const cache = await caches.open(LIBRARY_CACHE);
        if (next) {
          // Only what the publisher names as audio is kept: the worker serves
          // nothing else from this cache, so anything else would be a download
          // that never plays.
          const response = await fetch(href);
          if (!response.ok) throw new Error(`media ${response.status}`);
          if (!isOfflineAudio(response.headers.get('content-type'))) {
            notAudio = true;
            void response.body?.cancel().catch(() => {});
            throw new Error('not audio');
          }
          await cache.put(href, response);
          setCached(true);
          success('Saved for offline.');
        }
        else { await cache.delete(href); setCached(false); success('Removed from offline.'); }
      } catch {
        setCached(false);
        // The flag was written before the bytes were fetched, and used to stay
        // written when the fetch failed — so the row claimed a download that
        // did not exist and the tick asserted it. Put it back.
        // The rollback is itself a write; if it fails the flag stays set, and the
        // next visit says "Marked for offline, but not stored on this device
        // yet" rather than asserting a download — so it is logged, not raised.
        if (next) saveInBackground(writes, { itemId: item.id, offline: false });
        if (next) setOffline(false);
        error(notAudio ? t('library.onlyAudioOffline') : next ? 'That file could not be stored offline.' : 'That file could not be removed.');
      }
    });
  }

  const percent = progressPercent(position, item.durationSeconds);
  return (
    <li className="rounded-2xl border border-border bg-surface/40 p-3">
      <div className="flex items-start gap-3">
        {item.mediaUrl && (
          <Button size="sm" variant="secondary" onClick={toggle} aria-label={playing ? t('uiText.pause') : t('uiText.play')}>
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
          <Button size="sm" variant="ghost" onClick={toggleSaved} aria-label={saved ? t('uiText.removeFromSaved') : t('uiText.save')}>
            {saved ? <BookmarkCheck className="h-4 w-4 text-brand-text" /> : <Bookmark className="h-4 w-4" />}
          </Button>
          {item.mediaUrl && (
            <Button size="sm" variant="ghost" onClick={() => void toggleOffline()}
              aria-label={offline ? t('uiText.removeDownload') : t('uiText.saveForOffline')}>
              <Download className={`h-4 w-4 ${cached ? 'text-success' : ''}`} />
            </Button>
          )}
          {item.pageUrl && (
            <a href={safeWebLink(item.pageUrl) ?? undefined} target="_blank" rel="noreferrer noopener"
              className="rounded-lg p-2 text-muted hover:text-fg" aria-label="Open page">
              <ExternalLink className="h-4 w-4" />
            </a>
          )}
        </div>
      </div>
      {item.mediaUrl && (
        <audio ref={audioRef} src={mediaHref(item.id)} preload="none" onTimeUpdate={onTimeUpdate}
          onPlay={onPlay} onPause={onPause} onEnded={onEnded} />
      )}
      {offline && cached === false && (
        <p className="mt-1.5 text-xs text-warning">Marked for offline, but not stored on this device yet.</p>
      )}
      {!item.mediaUrl && !item.pageUrl && (
        // A title with nothing attached renders as a row with no play button,
        // no download and no link — and said nothing about why. It is a
        // perfectly reasonable thing to keep (a book you mean to read), so the
        // row explains itself rather than the buttons vanishing silently.
        <p className="mt-1.5 text-xs text-muted">Title only — add a link or an audio file to play or open it.</p>
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

/**
 * `allowMedia`: whether this person may attach an audio file. A book's media
 * address is streamed to every member from Bubaly's own origin, so attaching
 * one is the adults' to do (addBookAction refuses anyone else); a title or a
 * page link is anyone's.
 */
export function AddBookForm({ allowMedia = true }: { allowMedia?: boolean }) {
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
      {allowMedia && (
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Audio file <span className="text-muted">(optional)</span></span>
          <input name="mediaUrl" type="url" className={inputCls} placeholder="https://…/book.mp3" />
        </label>
      )}
      <Button type="submit" loading={pending} className="w-full">Add to library</Button>
    </form>
  );
}

export function FeedControls({ id, canRemove = true, canRefresh = true }: { id: string; canRemove?: boolean; canRefresh?: boolean }) {
  const { success, error } = useToast();
  const [pending, start] = useTransition();
  const run = (work: () => Promise<{ ok: true; message: string } | { ok: false; error: string }>) =>
    start(async () => {
      const result = await work();
      if (result.ok) success(result.message); else error(result.error);
    });
  return (
    <div className="flex gap-1">
      {canRefresh && (
        <Button size="sm" variant="ghost" loading={pending} onClick={() => run(() => refreshFeedAction(id))}>
          <RefreshCw className="h-4 w-4" /> Refresh
        </Button>
      )}
      {canRemove && (
        <Button size="sm" variant="ghost" loading={pending} onClick={() => run(() => unsubscribeFeedAction(id))}>
          <Trash2 className="h-4 w-4" /> Remove
        </Button>
      )}
    </div>
  );
}
