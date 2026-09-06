'use client';

// "On this day" — a delight surface on Home. Resurfaces the family's own photos
// taken on today's date in past years. Renders nothing on an ordinary day, so it
// only ever appears as a warm little gift, never as clutter.

import { useMemo } from 'react';
import Link from 'next/link';
import { Sparkles, ChevronRight } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import type { Tables } from '@/lib/database.types';
import { pickOnThisDay } from '@/lib/memories/on-this-day';
import { useTranslations } from '@/components/i18n/locale-provider';

type Photo = Tables<'family_photos'>;

export function OnThisDayCard() {
  const t = useTranslations();
  const { familyId } = useApp();

  const { data: rows } = useRealtimeQuery<Photo>({
    table: 'family_photos', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('family_photos').select('*')
      .eq('family_id', familyId).not('taken_at', 'is', null).not('url', 'is', null)
      .order('taken_at', { ascending: false }).limit(400),
  });

  const memories = useMemo(() => pickOnThisDay(rows ?? [], new Date(), 6), [rows]);
  if (memories.length === 0) return null;

  const lead = memories[0];
  const spanLabel = memories.length === 1
    ? lead.label
    : `${memories.length} memories · from ${memories[memories.length - 1].label}`;

  return (
    <Link
      href="/dashboard/memories"
      className="group flex items-center gap-4 rounded-2xl border border-accent/25 bg-gradient-to-r from-accent/10 to-transparent p-4 transition hover:border-accent/45 hover:from-accent/15 sm:p-5"
    >
      <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-accent/15 text-accent">
        <Sparkles className="h-6 w-6" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-accent">{t('onThisDay.onThisDay')}</span>
          <span className="text-xs font-medium text-muted">· {spanLabel}</span>
        </div>
        {lead.caption && <p className="mt-0.5 truncate text-sm font-medium">{lead.caption}</p>}
      </div>
      <div className="flex shrink-0 -space-x-3">
        {memories.slice(0, 4).map((m) => (
          <span key={m.id} className="relative h-12 w-12 overflow-hidden rounded-xl border-2 border-bg bg-elevated">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={m.thumbnail_url || m.url || ''} alt={m.caption ?? 'Family memory'} className="h-full w-full object-cover" loading="lazy" />
          </span>
        ))}
      </div>
      <ChevronRight className="h-5 w-5 shrink-0 text-muted transition group-hover:translate-x-0.5 group-hover:text-accent" />
    </Link>
  );
}
