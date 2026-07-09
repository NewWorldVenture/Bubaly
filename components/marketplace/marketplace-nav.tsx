'use client';

// The Marketplace section rail (V2 design). Lives INSIDE the bubaly global
// header/frame — it never replaces the app chrome. Per the design decisions:
//   • Home returns to the bubaly landing (/dashboard), not a marketplace home.
//   • Messages routes to the ONE bubaly Messages surface (/dashboard/messages) —
//     the marketplace has no separate inbox.
//   • Verifications routes to Trust & Permissions (the existing trust surface).

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import {
  Store, Home, Sparkles, Search, HelpCircle, Clock, Package, ShoppingBag,
  Gift, Repeat, FolderHeart, Users, Building2, ListChecks, MessageCircle,
  Receipt, Star, Heart, ShieldCheck, Plus,
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';

const BASE = '/dashboard/marketplace';

type Item = { href: string; label: string; icon: typeof Store; exact?: boolean; kind?: string };

const ITEMS: Item[] = [
  { href: BASE, label: 'Marketplace', icon: Store, exact: true },
  { href: '/dashboard', label: 'Home', icon: Home },
  { href: '/dashboard/assistant', label: 'AI Assistant', icon: Sparkles },
  { href: `${BASE}/browse`, label: 'Browse', icon: Search, exact: true },
  { href: `${BASE}/browse?kind=wanted`, label: 'Requests', icon: HelpCircle, kind: 'wanted' },
  { href: `${BASE}/browse?kind=rent`, label: 'Rentals', icon: Clock, kind: 'rent' },
  { href: `${BASE}/browse?kind=borrow`, label: 'Borrow & Lend', icon: Package, kind: 'borrow' },
  { href: `${BASE}/browse?kind=sell`, label: 'Buy & Sell', icon: ShoppingBag, kind: 'sell' },
  { href: `${BASE}/browse?kind=donate`, label: 'Donate', icon: Gift, kind: 'donate' },
  { href: `${BASE}/browse?kind=swap`, label: 'Swap', icon: Repeat, kind: 'swap' },
  { href: `${BASE}/collections`, label: 'Collections', icon: FolderHeart },
  { href: `${BASE}/creators`, label: 'Creators', icon: Users },
  { href: `${BASE}/store`, label: 'My Store', icon: Building2 },
  { href: `${BASE}/store#listings`, label: 'My Listings', icon: ListChecks },
  { href: '/dashboard/messages', label: 'Messages', icon: MessageCircle },
  { href: `${BASE}/orders`, label: 'Orders', icon: Receipt },
  { href: `${BASE}/reviews`, label: 'Reviews', icon: Star },
  { href: `${BASE}/saved`, label: 'Saved', icon: Heart },
  { href: '/dashboard/trust', label: 'Verifications', icon: ShieldCheck },
];

function NavList() {
  const pathname = usePathname();
  const params = useSearchParams();
  const activeKind = pathname === `${BASE}/browse` ? params.get('kind') : null;

  const isActive = (it: Item): boolean => {
    const [path] = it.href.split(/[?#]/);
    if (it.kind) return path === pathname && activeKind === it.kind;
    if (it.exact) return pathname === path && (path !== `${BASE}/browse` || !activeKind);
    if (path === '/dashboard' || path === '/dashboard/assistant' || path === '/dashboard/messages' || path === '/dashboard/trust') {
      return pathname === path;
    }
    return pathname.startsWith(path);
  };

  return (
    <nav aria-label="Marketplace sections" className="space-y-0.5">
      {ITEMS.map((it) => {
        const Icon = it.icon;
        const active = isActive(it);
        return (
          <Link
            key={it.label}
            href={it.href}
            className={cn(
              'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition',
              active ? 'bg-brand/12 font-medium text-brand' : 'text-muted hover:bg-elevated hover:text-fg',
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="truncate">{it.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

export function MarketplaceNav() {
  return (
    <div className="flex h-full flex-col gap-3">
      <Suspense fallback={null}>
        <NavList />
      </Suspense>
      <Link
        href={`${BASE}/browse?post=1`}
        className="mt-1 inline-flex items-center justify-center gap-2 rounded-xl bg-brand px-3 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90"
      >
        <Plus className="h-4 w-4" /> Post an Item
      </Link>
      <p className="text-center text-[11px] text-muted">Sell, rent, lend, borrow &amp; more</p>
    </div>
  );
}
