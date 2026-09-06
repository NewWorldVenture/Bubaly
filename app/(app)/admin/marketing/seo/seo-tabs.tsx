'use client';

// Client-side tab switcher for the Marketing SEO console. The three panels are
// rendered on the server (they contain server-action forms) and passed in as
// React nodes — this component only toggles which one is visible, so switching
// is instant with no refetch.
import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from '@/components/i18n/locale-provider';

export type SeoTab = { id: string; label: string; count?: number; panel: ReactNode };

export function SeoTabs({ tabs }: { tabs: SeoTab[] }) {
  const tr = useTranslations();
  const [active, setActive] = useState(tabs[0]?.id ?? '');
  const current = tabs.find((t) => t.id === active) ?? tabs[0];

  return (
    <div>
      <div role="tablist" aria-label={tr('adminMarketingSeoSeoTabs.seoSections')} className="flex flex-wrap gap-1 border-b border-border">
        {tabs.map((t) => {
          const selected = t.id === current?.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setActive(t.id)}
              className={cn(
                'rounded-t-xl px-4 py-2.5 text-sm font-medium transition',
                selected
                  ? 'border border-b-0 border-border bg-surface/60 font-semibold text-fg'
                  : 'text-muted hover:text-fg',
              )}
            >
              {t.label}
              {typeof t.count === 'number' && (
                <span className="ml-1.5 text-xs text-muted">({t.count.toLocaleString()})</span>
              )}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" className="pt-5">
        {current?.panel}
      </div>
    </div>
  );
}
