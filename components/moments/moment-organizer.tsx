'use client';

// Moments organizing layer (R12) — the "right now" band that opens the Moments
// page. Each card is the life moment the family is in (or one that's coming) with
// the handful of capabilities it orchestrates, so they act by MOMENT, not by
// hunting modules. Dismiss keeps a moment quiet for the day.
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Sunrise, GraduationCap, UtensilsCrossed, NotebookPen, Moon, Palmtree, Plane, Cake,
  PartyPopper, ShieldAlert, ChevronRight, X, Compass,
} from 'lucide-react';
import { dismissMomentAction } from '@/app/(app)/dashboard/moments/actions';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';
import type { MomentKey } from '@/lib/moments/organizer';
import { useTranslations } from '@/components/i18n/locale-provider';

export interface OrganizerMoment {
  key: string; label: string; blurb: string; reason: string;
  capabilities: { label: string; href: string }[];
}

const ICON: Record<MomentKey, React.ComponentType<{ className?: string }>> = {
  morning: Sunrise, school: GraduationCap, dinner: UtensilsCrossed, homework: NotebookPen,
  bedtime: Moon, weekend: Palmtree, vacation: Plane, birthday: Cake, holiday: PartyPopper, emergency: ShieldAlert,
};

export function MomentOrganizer({ moments }: { moments: OrganizerMoment[] }) {
  const t = useTranslations();
  const router = useRouter();
  const { error: toastError } = useToast();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();

  const shown = moments.filter((m) => !hidden.has(m.key));
  if (shown.length === 0) return null;

  function dismiss(key: string) {
    setHidden((prev) => new Set(prev).add(key)); // optimistic
    startTransition(async () => {
      const res = await dismissMomentAction(key);
      if (!res.ok) {
        // Roll back the optimistic hide AND tell the user — a silent revert just
        // makes the card reappear with no explanation of why dismiss didn't stick.
        setHidden((prev) => { const n = new Set(prev); n.delete(key); return n; });
        toastError(res.error ?? 'Could not dismiss this moment. Please try again.');
        return;
      }
      router.refresh();
    });
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Compass className="h-4 w-4 text-brand-text" />
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">{t('momentOrganizer.rightNow')}</h2>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {shown.map((m) => {
          const Icon = ICON[m.key as MomentKey] ?? Compass;
          return (
            <div key={m.key} className="relative rounded-2xl border border-border bg-surface/40 p-4">
              <button type="button" onClick={() => dismiss(m.key)} disabled={pending} aria-label={`Dismiss ${m.label}`}
                className="absolute right-2.5 top-2.5 grid h-6 w-6 place-items-center rounded-full text-muted transition hover:bg-elevated hover:text-fg disabled:opacity-50">
                <X className="h-3.5 w-3.5" />
              </button>
              <div className="flex items-start gap-3 pr-6">
                <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand/15 text-brand-text"><Icon className="h-5 w-5" /></div>
                <div className="min-w-0">
                  <p className="text-sm font-bold">{m.label}</p>
                  <p className="truncate text-xs text-muted">{m.reason}</p>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {m.capabilities.map((c) => (
                  <Link key={c.href} href={c.href}
                    className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-bg/40 px-2.5 py-1 text-xs font-medium transition hover:border-brand/40 hover:bg-brand/5">
                    {c.label} <ChevronRight className="h-3 w-3 text-muted" />
                  </Link>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
