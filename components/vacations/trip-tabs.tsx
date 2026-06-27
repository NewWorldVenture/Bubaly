'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard, CalendarRange, Plane, BedDouble, Ticket, Wallet,
  Luggage, FolderLock, Users, ShieldAlert, CloudSun, Sparkles,
} from 'lucide-react';

const TABS = [
  { seg: 'overview', label: 'Overview', icon: LayoutDashboard },
  { seg: 'itinerary', label: 'Itinerary', icon: CalendarRange },
  { seg: 'travel', label: 'Travel', icon: Plane },
  { seg: 'lodging', label: 'Lodging', icon: BedDouble },
  { seg: 'activities', label: 'Activities', icon: Ticket },
  { seg: 'budget', label: 'Budget', icon: Wallet },
  { seg: 'packing', label: 'Packing', icon: Luggage },
  { seg: 'documents', label: 'Documents', icon: FolderLock },
  { seg: 'family', label: 'Family', icon: Users },
  { seg: 'emergency', label: 'Emergency', icon: ShieldAlert },
  { seg: 'weather', label: 'Weather', icon: CloudSun },
  { seg: 'ai-assistant', label: 'AI Concierge', icon: Sparkles },
];

export function TripTabs({ tripId }: { tripId: string }) {
  const pathname = usePathname();
  return (
    <nav className="-mx-1 flex gap-1 overflow-x-auto pb-1">
      {TABS.map((t) => {
        const href = `/dashboard/vacations/${tripId}/${t.seg}`;
        const active = pathname === href;
        const Icon = t.icon;
        return (
          <Link key={t.seg} href={href}
            className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition ${active ? 'bg-brand text-brand-fg' : 'text-muted hover:bg-elevated hover:text-fg'}`}>
            <Icon className="h-4 w-4" /> {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
