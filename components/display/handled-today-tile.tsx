'use client';

// components/display/handled-today-tile.tsx — "Bubaly handled today" on the wall.
//
// The one rule this tile exists to obey: a number on a kitchen wall is a CLAIM,
// and a claim needs a row behind it. The count is the family's own COMPLETED
// runs for today (`family_automation_runs.state = 'completed'`, read server-side
// in app/(app)/display/page.tsx and carried here as data) — never the length of
// a list that was trimmed, never a partially completed run rounded up to done.
//
// And when the read fails, this renders "Bubaly could not read what it finished"
// with a way to retry. It never renders 0. "Nothing finished today" and "the
// database did not answer" are different facts and a wall display is exactly
// where confusing them does the most damage: nobody is at the keyboard to
// notice, and everyone in the house reads it on their way past.

import Link from 'next/link';
import { CheckCircle2, AlertTriangle, RotateCw } from 'lucide-react';
import { fmtTime } from '@/lib/utils/format';
import { useTranslations } from '@/components/i18n/locale-provider';

/** One finished run, shaped by the server page from the ledger row. */
export type HandledTodayItem = {
  key: string;
  title: string;
  href: string;
  /** ISO timestamp the run completed. */
  at: string;
};

/**
 * What the server managed to read. `error` is a real state with its own render:
 * there is deliberately no third "unknown" shape that could be mistaken for a
 * quiet day.
 */
export type HandledToday =
  | { status: 'ok'; count: number; items: HandledTodayItem[] }
  | { status: 'error' };

/** How many rows the tile lists under the count. */
export const HANDLED_TILE_ITEMS = 3;

export function HandledTodayTile({ handled, onRetry }: { handled?: HandledToday; onRetry?: () => void }) {
  const t = useTranslations();

  // `undefined` is the same fact as an error — the page did not hand this tile a
  // reading — so it fails closed rather than falling through to a zero.
  if (!handled || handled.status === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <AlertTriangle className="h-7 w-7 text-amber-300/80" aria-hidden />
        <p className="text-sm font-medium text-white/80">{t('displayHandled.couldNotLoad')}</p>
        <button
          type="button"
          onClick={() => (onRetry ? onRetry() : window.location.reload())}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-white/20 px-3 py-1.5 text-xs font-semibold text-white/80 transition hover:bg-white/10"
        >
          <RotateCw className="h-3.5 w-3.5" aria-hidden /> {t('displayHandled.retry')}
        </button>
      </div>
    );
  }

  const items = handled.items.slice(0, HANDLED_TILE_ITEMS);

  return (
    <div className="flex h-full flex-col">
      <p className="text-4xl font-black text-white">
        {handled.count}
        <span className="ml-1.5 text-base font-normal text-white/50">{t('displayHandled.finishedToday')}</span>
      </p>
      {items.length ? (
        <ul className="mt-2 min-h-0 flex-1 space-y-1.5 overflow-y-auto text-sm scrollbar-none">
          {items.map((item) => (
            <li key={item.key} className="flex items-start gap-2">
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-300" aria-hidden />
              <Link href={item.href} className="min-w-0 flex-1 truncate text-white/85 hover:text-white">
                {item.title}
              </Link>
              <span className="shrink-0 text-[11px] tabular-nums text-white/40">{fmtTime(item.at)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-white/45">{t('displayHandled.nothingFinishedYet')}</p>
      )}
    </div>
  );
}
