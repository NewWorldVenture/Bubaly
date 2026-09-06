'use client';

// A single "All Services" category page: the category's features, plan-gated.
// Available features link straight through; above-plan features render locked and
// open the upgrade prompt (never a dead end). Off features are hidden entirely.
import { useState } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { resolveItems, NavEntry } from '@/components/app/nav-shared';
import { UpgradeModal } from '@/components/app/upgrade-modal';
import { SERVICE_CATEGORY_BY_ID, navItemsForHrefs } from '@/lib/constants/service-categories';
import type { NavItem } from '@/lib/constants/navigation';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from '@/components/i18n/locale-provider';

export function ServiceCategoryView({ categoryId }: { categoryId: string }) {
  const t = useTranslations();
  const { planLevel, isSuperAdmin, featureTiers } = useApp();
  const [upgradeFor, setUpgradeFor] = useState<NavItem | null>(null);

  const category = SERVICE_CATEGORY_BY_ID[categoryId];
  if (!category) return notFound();

  const items = resolveItems(navItemsForHrefs(category.hrefs), featureTiers, planLevel, isSuperAdmin);
  const Icon = category.icon;
  const upgradeLevel: 1 | 2 = upgradeFor ? (featureTiers[upgradeFor.href] === 'plus' ? 2 : 1) : 1;

  return (
    <div className="mx-auto w-full max-w-3xl">
      {/* Header */}
      <div className="mb-6 flex items-center gap-3">
        <Link
          href="/services"
          aria-label={t('serviceCategory.backToAllServices')}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-elevated hover:text-fg"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <span className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-xl', category.tint)}>
          <Icon className="h-6 w-6" />
        </span>
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight">{category.label}</h1>
          <p className="text-xs text-muted">{category.description}</p>
        </div>
      </div>

      {items.length === 0 ? (
        <p className="rounded-2xl border border-border bg-surface/40 p-8 text-center text-sm text-muted">
          {t('serviceCategory.nothingHereYetForYourPlan')}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {items.map(({ item, locked }) => (
            <NavEntry key={item.href} item={item} variant="grid" locked={locked} onLocked={setUpgradeFor} />
          ))}
        </div>
      )}

      <UpgradeModal
        open={upgradeFor !== null}
        onClose={() => setUpgradeFor(null)}
        featureLabel={upgradeFor?.label}
        requiredLevel={upgradeLevel}
      />
    </div>
  );
}
