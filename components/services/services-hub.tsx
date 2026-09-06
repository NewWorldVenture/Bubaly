'use client';

// The "All Services" hub (mobile Services tab). Eight category cards with live,
// tier-aware tool counts, an Upgrade banner (hidden once on Plus), and Quick
// Actions. Each card opens a category page listing its features, plan-gated.
import Link from 'next/link';
import { ChevronRight, Crown, Calendar, CheckCircle2, Receipt, MessageSquare } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { resolveItems } from '@/components/app/nav-shared';
import { SERVICE_CATEGORIES, navItemsForHrefs } from '@/lib/constants/service-categories';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from '@/components/i18n/locale-provider';

const QUICK_ACTIONS = [
  { href: '/dashboard/calendar', label: 'Add Event', icon: Calendar, tint: 'bg-violet-500/15 text-violet-300' },
  { href: '/dashboard/todos', label: 'Add Task', icon: CheckCircle2, tint: 'bg-emerald-500/15 text-emerald-300' },
  { href: '/dashboard/expenses', label: 'Add Expense', icon: Receipt, tint: 'bg-amber-500/15 text-amber-300' },
  { href: '/dashboard/messages', label: 'Send Message', icon: MessageSquare, tint: 'bg-blue-500/15 text-blue-300' },
];

export function ServicesHub() {
  const t = useTranslations();
  const { planLevel, isSuperAdmin, featureTiers } = useApp();

  return (
    <div className="mx-auto w-full max-w-3xl">
      <header className="mb-6 text-center sm:mb-7">
        <h1 className="text-2xl font-bold tracking-tight">{t('services.allServices')}</h1>
        <p className="mt-1 text-sm text-muted">{t('services.everythingYourFamilyNeedsAllIn')}</p>
      </header>

      {/* Category cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {SERVICE_CATEGORIES.map((cat) => {
          const count = resolveItems(navItemsForHrefs(cat.hrefs), featureTiers, planLevel, isSuperAdmin).length;
          if (count === 0) return null; // whole category gated Off → hide
          const Icon = cat.icon;
          return (
            <Link
              key={cat.id}
              href={`/services/${cat.id}`}
              className="group flex flex-col gap-3 rounded-2xl border border-border bg-surface/40 p-4 transition hover:border-brand/40 hover:bg-surface/70"
            >
              <div className="flex items-start gap-3">
                <span className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-xl', cat.tint)}>
                  <Icon className="h-6 w-6" />
                </span>
                <div className="min-w-0">
                  <h2 className="text-base font-bold leading-tight">{cat.label}</h2>
                  <p className="mt-0.5 text-xs leading-snug text-muted">{cat.description}</p>
                </div>
              </div>
              <div className="mt-auto flex items-center justify-between">
                <span className="text-sm font-semibold text-brand-text">
                  {count} {cat.countLabel === 'integrations' ? 'Integrations' : `Tool${count === 1 ? '' : 's'}`}
                </span>
                <span className="grid h-8 w-8 place-items-center rounded-full border border-border text-muted transition group-hover:border-brand/40 group-hover:text-brand-text">
                  <ChevronRight className="h-4 w-4" />
                </span>
              </div>
            </Link>
          );
        })}
      </div>

      {/* Upgrade banner (hidden once on Plus) */}
      {planLevel < 2 && !isSuperAdmin && (
        <Link
          href="/dashboard/billing?upgrade=1"
          className="mt-4 flex items-center gap-4 rounded-2xl border border-brand/30 bg-brand/5 p-4 transition hover:bg-brand/10"
        >
          <Crown className="h-9 w-9 shrink-0 text-amber-400" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold">{t('services.upgradeToPlus')}</p>
            <p className="mt-0.5 text-xs leading-snug text-muted">
              {t('services.unlockPremiumFeaturesAcrossAllServices')}
            </p>
          </div>
          <ChevronRight className="h-5 w-5 shrink-0 text-muted" />
        </Link>
      )}

      {/* Quick Actions */}
      <section className="mt-6">
        <h2 className="mb-2 text-sm font-bold">{t('services.quickActions')}</h2>
        <div className="grid grid-cols-4 gap-2 sm:gap-3">
          {QUICK_ACTIONS.map((qa) => {
            const Icon = qa.icon;
            return (
              <Link
                key={qa.href}
                href={qa.href}
                className="flex flex-col items-center gap-2 rounded-2xl border border-border bg-surface/40 p-3 text-center transition hover:border-brand/40 hover:bg-surface/70"
              >
                <span className={cn('grid h-10 w-10 place-items-center rounded-xl', qa.tint)}>
                  <Icon className="h-5 w-5" />
                </span>
                <span className="text-[11px] font-medium leading-tight text-muted">{qa.label}</span>
              </Link>
            );
          })}
        </div>
      </section>
    </div>
  );
}
