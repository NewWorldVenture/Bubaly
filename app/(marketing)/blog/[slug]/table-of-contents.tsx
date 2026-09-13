'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from '@/components/i18n/locale-provider';

type Heading = { id: string; text: string };

/**
 * The scroll-spy window: ignore the top 80px, which sits under the sticky
 * header, and the bottom 60%, so a heading counts as "current" only once it
 * has actually reached the reading area.
 *
 * This was a catalogue key. A CSS margin has no language, and every one of the
 * eleven translations carried an identical copy of it — one edit away, in a
 * translation tool, from a value IntersectionObserver rejects, which throws at
 * construction and takes the whole table of contents down for that locale.
 */
const SCROLL_SPY_MARGIN = '-80px 0px -60% 0px';

export function TableOfContents({ headings }: { headings: Heading[] }) {
  const t = useTranslations();
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
          }
        }
      },
      { rootMargin: SCROLL_SPY_MARGIN, threshold: 0.1 },
    );

    for (const { id } of headings) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }

    return () => observer.disconnect();
  }, [headings]);

  return (
    <nav className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
      <h3 className="mb-3 text-sm font-bold">{t('blogTableOfContents.inThisArticle')}</h3>
      <ul className="space-y-2">
        {headings.map(({ id, text }) => (
          <li key={id}>
            <a
              href={`#${id}`}
              className={cn(
                'block border-l-2 py-1 pl-3 text-xs leading-5 transition',
                activeId === id
                  ? 'border-violet-400 font-semibold text-violet-200'
                  : 'border-transparent text-white/45 hover:border-white/20 hover:text-white/70',
              )}
            >
              {text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
