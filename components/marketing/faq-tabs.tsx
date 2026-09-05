'use client';

import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { FAQAccordion, type FAQ } from '@/components/marketing/faq-accordion';
import { cn } from '@/lib/utils/cn';

export type FaqSection = { id: string; label: string; items: FAQ[] };

/**
 * Mobile-first, fully-accessible FAQ browser: sections rendered as a WAI-ARIA
 * tablist (roving tabindex + arrow/Home/End keys) with one accordion panel per
 * section. The tab strip scrolls horizontally on small screens and wraps/centres
 * on larger ones, so it stays touch-friendly at every width.
 */
export function FaqTabs({ sections }: { sections: FaqSection[] }) {
  const baseId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [active, setActive] = useState(0);

  if (sections.length === 0) return null;
  const activeIndex = Math.min(active, sections.length - 1);

  const focusTab = (index: number) => {
    const next = (index + sections.length) % sections.length;
    setActive(next);
    tabRefs.current[next]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown': e.preventDefault(); focusTab(index + 1); break;
      case 'ArrowLeft':
      case 'ArrowUp': e.preventDefault(); focusTab(index - 1); break;
      case 'Home': e.preventDefault(); focusTab(0); break;
      case 'End': e.preventDefault(); focusTab(sections.length - 1); break;
      default: break;
    }
  };

  return (
    <div className="mx-auto max-w-3xl">
      <div
        role="tablist"
        aria-label="FAQ categories"
        className="scrollbar-none -mx-4 flex snap-x gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:justify-center sm:px-0"
      >
        {sections.map((section, index) => {
          const selected = index === activeIndex;
          return (
            <button
              key={section.id}
              ref={(el) => { tabRefs.current[index] = el; }}
              role="tab"
              id={`${baseId}-tab-${section.id}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel-${section.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(index)}
              onKeyDown={(e) => onKeyDown(e, index)}
              className={cn(
                'inline-flex min-h-[44px] shrink-0 snap-start items-center gap-1.5 whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium transition focus-ring',
                selected
                  ? 'bg-gradient-to-r from-blue-500 to-violet-600 text-brand-fg shadow-glow'
                  : 'border border-border bg-surface/50 text-muted hover:bg-elevated hover:text-fg',
              )}
            >
              {section.label}
              <span className={cn('text-xs tabular-nums', selected ? 'text-brand-fg/80' : 'text-muted')}>
                {section.items.length}
              </span>
            </button>
          );
        })}
      </div>

      {sections.map((section, index) => (
        <div
          key={section.id}
          role="tabpanel"
          id={`${baseId}-panel-${section.id}`}
          aria-labelledby={`${baseId}-tab-${section.id}`}
          hidden={index !== activeIndex}
          className="mt-6"
        >
          {index === activeIndex && <FAQAccordion items={section.items} />}
        </div>
      ))}
    </div>
  );
}
