'use client';

// Mobile parity for the desktop "All Services" launcher: the full, searchable,
// plan-gated catalog of every module, surfaced on the /dashboard/more hub so
// phone users can reach anything (the bottom nav is only 5 tabs). Locked
// (above-plan) services route to the paywall.

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { APP_NAV_GROUPS } from '@/lib/constants/navigation';
import { useApp } from '@/components/app/app-context';
import { resolveItems, NavEntry } from '@/components/app/nav-shared';

export function MobileServicesCatalog() {
  const { planLevel, isSuperAdmin, featureTiers } = useApp();
  const router = useRouter();
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();

  const groups = useMemo(() =>
    APP_NAV_GROUPS
      .map((g) => ({
        title: g.title,
        items: resolveItems(g.items, featureTiers, planLevel, isSuperAdmin)
          .filter(({ item }) => !query || item.label.toLowerCase().includes(query)),
      }))
      .filter((g) => g.items.length > 0),
  [featureTiers, planLevel, isSuperAdmin, query]);

  return (
    <section>
      <h2 className="px-1 pb-2 text-xs font-semibold uppercase tracking-wide text-muted">All Services</h2>
      <label className="mb-3 flex h-11 items-center gap-2 rounded-xl border border-border bg-surface/40 px-3 text-muted">
        <Search className="h-4 w-4 shrink-0" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search services…"
          className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-muted"
        />
      </label>
      {groups.length === 0 ? (
        <p className="px-1 text-sm text-muted">No services match “{q}”.</p>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => (
            <div key={g.title} className="space-y-1">
              <p className="px-1 text-[11px] font-semibold uppercase tracking-wide text-muted/70">{g.title}</p>
              <div className="grid grid-cols-2 gap-1">
                {g.items.map(({ item, locked }) => (
                  <NavEntry key={item.href} item={item} variant="grid" locked={locked} onLocked={() => router.push('/pricing')} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
