'use client';

// Idle photo frame — the Echo Show signature. After `idleMinutes` without any
// interaction the display fades to a full-bleed slideshow of family photos with
// a big clock, the date, and the next event. Any tap/mouse/key wakes it. When
// the family has no photos, a slow-shifting ambient gradient stands in so the
// frame still protects the panel and looks intentional.
import { useCallback, useEffect, useRef, useState } from 'react';
import { AmbientClock } from './ambient-clock';

const ROTATE_MS = 20_000;

export function PhotoFrame({ photos, idleMinutes, clock24, nextLine }: {
  photos: string[];
  idleMinutes: number;   // 0 = off
  clock24: boolean;
  nextLine: string | null;
}) {
  const [idle, setIdle] = useState(false);
  const [photoIdx, setPhotoIdx] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const arm = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    if (idleMinutes <= 0) return;
    timer.current = setTimeout(() => setIdle(true), idleMinutes * 60_000);
  }, [idleMinutes]);

  useEffect(() => {
    if (idleMinutes <= 0) { setIdle(false); return; }
    const wake = () => { setIdle(false); arm(); };
    arm();
    const events: (keyof WindowEventMap)[] = ['pointerdown', 'pointermove', 'keydown', 'touchstart', 'wheel'];
    for (const e of events) window.addEventListener(e, wake, { passive: true });
    return () => {
      if (timer.current) clearTimeout(timer.current);
      for (const e of events) window.removeEventListener(e, wake);
    };
  }, [idleMinutes, arm]);

  useEffect(() => {
    if (!idle || photos.length < 2) return;
    const id = setInterval(() => setPhotoIdx((i) => (i + 1) % photos.length), ROTATE_MS);
    return () => clearInterval(id);
  }, [idle, photos.length]);

  if (!idle) return null;

  const url = photos[photoIdx % Math.max(1, photos.length)];
  return (
    <div
      className="fixed inset-0 z-50 animate-fade-in overflow-hidden bg-black"
      role="button"
      aria-label="Wake display"
      tabIndex={0}
    >
      {photos.length > 0 ? (
        photos.map((p, i) => (
          // Stack all photos; crossfade by opacity so transitions are seamless.
          // eslint-disable-next-line @next/next/no-img-element
          <img key={p} src={p} alt="" aria-hidden
            className="absolute inset-0 h-full w-full object-cover transition-opacity duration-[3000ms]"
            style={{ opacity: p === url ? 1 : 0, zIndex: i === photoIdx ? 1 : 0 }} />
        ))
      ) : (
        <div className="absolute inset-0" style={{ background: 'radial-gradient(120% 120% at 30% 10%, #1e3a8a 0%, #172554 45%, #020617 100%)' }} />
      )}
      <div className="absolute inset-0 z-10 bg-gradient-to-t from-black/75 via-transparent to-black/30" />
      <div className="absolute bottom-10 left-10 z-20">
        <AmbientClock clock24={clock24} seconds={false} />
      </div>
      {nextLine && (
        <p className="absolute bottom-10 right-10 z-20 max-w-sm truncate rounded-2xl bg-black/40 px-4 py-2 text-right text-sm text-white/85 backdrop-blur-md">
          {nextLine}
        </p>
      )}
    </div>
  );
}
