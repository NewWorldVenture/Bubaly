'use client';

// Hover/focus tooltips for the "All Services" catalog. Two pieces:
//   • useServiceDescriptions() — the merged description map. Starts from the
//     bundled code DEFAULTS (instant, zero-latency tooltips) and lazily overlays
//     any super-admin overrides fetched once from /api/services/descriptions
//     (module-memoized so all instances share one fetch).
//   • <ServiceTooltip> — wraps a catalog cell; on hover/focus it shows a single
//     FIXED-position card anchored to the trigger, so it never clips inside the
//     modal's scroll container. Keyboard-accessible (focus shows it too).

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SERVICE_DESCRIPTIONS, mergeServiceDescriptions } from '@/lib/services/descriptions';
import { cn } from '@/lib/utils/cn';

// One shared, cached overrides fetch across every hook consumer.
let overridesCache: Record<string, string> | null = null;
let overridesPromise: Promise<Record<string, string>> | null = null;

function fetchOverrides(): Promise<Record<string, string>> {
  if (overridesCache) return Promise.resolve(overridesCache);
  if (!overridesPromise) {
    overridesPromise = fetch('/api/services/descriptions', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { overrides: {} }))
      .then((d: { overrides?: Record<string, string> }) => {
        overridesCache = d.overrides ?? {};
        return overridesCache;
      })
      .catch(() => {
        overridesCache = {};
        return overridesCache;
      });
  }
  return overridesPromise;
}

/** The merged service-description map: bundled defaults + lazily-loaded overrides. */
export function useServiceDescriptions(): Record<string, string> {
  const [map, setMap] = useState<Record<string, string>>(() =>
    overridesCache ? mergeServiceDescriptions(overridesCache) : SERVICE_DESCRIPTIONS,
  );
  useEffect(() => {
    let active = true;
    void fetchOverrides().then((ov) => { if (active) setMap(mergeServiceDescriptions(ov)); });
    return () => { active = false; };
  }, []);
  return map;
}

type Pos = { top: number; left: number; placement: 'top' | 'bottom' };

/** Wraps a catalog cell and shows a fixed tooltip anchored to it on hover/focus. */
export function ServiceTooltip({ label, description, children }: {
  label: string; description: string; children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Pos | null>(null);

  const show = useCallback(() => {
    const el = ref.current;
    if (!el || !description) return;
    const r = el.getBoundingClientRect();
    // Prefer above; flip below when there isn't room at the top.
    const placement: 'top' | 'bottom' = r.top > 150 ? 'top' : 'bottom';
    setPos({
      left: Math.min(Math.max(r.left + r.width / 2, 160), window.innerWidth - 160),
      top: placement === 'top' ? r.top - 8 : r.bottom + 8,
      placement,
    });
  }, [description]);

  const hide = useCallback(() => setPos(null), []);

  return (
    <div
      ref={ref}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocusCapture={show}
      onBlurCapture={hide}
    >
      {children}
      {pos && typeof document !== 'undefined' && createPortal(
        <div
          role="tooltip"
          style={{
            position: 'fixed', left: pos.left, top: pos.top, transform: `translate(-50%, ${pos.placement === 'top' ? '-100%' : '0'})`,
            zIndex: 90,
          }}
          className={cn(
            'popover-surface pointer-events-none w-72 max-w-[80vw] p-3 text-left',
            'animate-in fade-in zoom-in-95 duration-100',
          )}
        >
          <p className="text-xs font-bold text-fg">{label}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted">{description}</p>
        </div>,
        document.body,
      )}
    </div>
  );
}
