'use client';

// "Do one thing now" (M30) — the handoff a brand-new family did not have.
//
// It is a door, not a report. Everything on it is either fixed copy or comes
// from `pickFirstThing`, which reads the family's own snapshot; nothing here
// claims Bubaly did anything, because at this point it has not.
import Link from 'next/link';
import { ArrowRight, Target } from 'lucide-react';
import type { FirstThing } from '@/lib/outcomes/launcher';
import { useTranslations } from '@/components/i18n/locale-provider';

export function DoOneThingCard({ thing, className }: { thing: FirstThing; className?: string }) {
  const t = useTranslations();
  return (
    <Link
      href={thing.href}
      className={
        className
        ?? 'flex items-center gap-3 rounded-2xl border border-brand/30 bg-brand/5 px-4 py-3 text-left transition hover:border-brand/50 hover:bg-brand/10'
      }
    >
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand/15 text-brand-text">
        <Target className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[11px] font-semibold uppercase tracking-wide text-brand-text">{t('doOneThing.title')}</span>
        <span className="block truncate text-sm font-semibold">{t(thing.labelKey)}</span>
        <span className="block truncate text-xs text-muted">{t(thing.detailKey)}</span>
      </span>
      <ArrowRight className="h-4 w-4 shrink-0 text-muted" />
    </Link>
  );
}
