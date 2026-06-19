'use client';

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

export type FAQ = { q: string; a: string };

export function FAQAccordion({ items }: { items: FAQ[] }) {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <div className="mx-auto max-w-3xl space-y-3">
      {items.map((item, i) => {
        const isOpen = open === i;
        return (
          <div key={item.q} className="glass-card overflow-hidden p-0">
            <button
              className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left focus-ring"
              onClick={() => setOpen(isOpen ? null : i)}
              aria-expanded={isOpen}
            >
              <span className="font-medium">{item.q}</span>
              <ChevronDown
                className={cn('h-5 w-5 shrink-0 text-muted transition-transform', isOpen && 'rotate-180')}
              />
            </button>
            {isOpen && (
              <div className="border-t border-border px-5 py-4 text-sm text-muted animate-fade-in">
                {item.a}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
