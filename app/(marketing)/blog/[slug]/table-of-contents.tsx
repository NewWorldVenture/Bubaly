'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils/cn';

type Heading = { id: string; text: string };

export function TableOfContents({ headings }: { headings: Heading[] }) {
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
      { rootMargin: '-80px 0px -60% 0px', threshold: 0.1 },
    );

    for (const { id } of headings) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }

    return () => observer.disconnect();
  }, [headings]);

  return (
    <nav className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
      <h3 className="mb-3 text-sm font-bold">In This Article</h3>
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
