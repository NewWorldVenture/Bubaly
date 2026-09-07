'use client';

// The Messages GIF picker popover. Searches through /api/gif/search (the Giphy
// key never reaches the client). Debounced search over a trending default; a
// pick hands the GIF URL to the composer, which sends it as an image message.
// Honest key-gating: a 503 from the route renders a "not configured" note.
import { useEffect, useRef, useState } from 'react';
import { Loader2, SearchX } from 'lucide-react';
import { useTranslations } from '@/components/i18n/locale-provider';

type Gif = { id: string; title: string; previewUrl: string; url: string };

export function GifPicker({ onPick, onClose }: { onPick: (url: string, title: string) => void; onClose: () => void }) {
  const tr = useTranslations();
  const [q, setQ] = useState('');
  const [gifs, setGifs] = useState<Gif[] | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'unconfigured' | 'error'>('loading');
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(async () => {
      setState('loading');
      try {
        const res = await fetch(`/api/gif/search?q=${encodeURIComponent(q)}`);
        if (res.status === 503) { setState('unconfigured'); return; }
        if (!res.ok) { setState('error'); return; }
        const json = await res.json() as { gifs: Gif[] };
        setGifs(json.gifs ?? []);
        setState('ready');
      } catch { setState('error'); }
    }, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [q]);

  // Close on outside click.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  return (
    <div ref={boxRef} className="absolute bottom-11 right-0 z-20 w-72 rounded-xl border border-border bg-elevated p-2 shadow-xl sm:w-80">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={tr('gifPicker.searchGifs')}
        autoFocus
        aria-label={tr('gifPicker.searchGifs')}
        className="mb-2 h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm outline-none focus:border-brand"
      />
      {state === 'unconfigured' && (
        <p className="px-1 pb-1 text-xs text-muted">{tr('gifPicker.gifSearchIsntConfiguredYetAsk')}</p>
      )}
      {state === 'error' && <p className="px-1 pb-1 text-xs text-danger">{tr('gifPicker.couldntLoadGifsTryAgain')}</p>}
      {state === 'loading' && (
        <div className="grid h-40 place-items-center"><Loader2 className="h-5 w-5 animate-spin text-muted" /></div>
      )}
      {state === 'ready' && (
        gifs && gifs.length > 0 ? (
          <div className="grid max-h-64 grid-cols-3 gap-1 overflow-y-auto">
            {gifs.map((g) => (
              // Remote Giphy preview thumbnails — next/image is not usable here
              // (external host, no loader) and previews are tiny fixed-width GIFs.
              // eslint-disable-next-line @next/next/no-img-element
              <button key={g.id} type="button" onClick={() => onPick(g.url, g.title)} className="overflow-hidden rounded-lg transition hover:opacity-80">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={g.previewUrl} alt={g.title} loading="lazy" className="h-20 w-full object-cover" />
              </button>
            ))}
          </div>
        ) : (
          <div className="grid h-24 place-items-center text-muted"><SearchX className="h-5 w-5" /></div>
        )
      )}
      <p className="mt-1.5 px-1 text-right text-[10px] text-muted">{tr('gifPicker.poweredByGiphy')}</p>
    </div>
  );
}
