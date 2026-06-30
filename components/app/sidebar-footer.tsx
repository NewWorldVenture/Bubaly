'use client';

// The shared bottom-left footer for EVERY sidebar (Free + paid, desktop rail +
// mobile drawer): a divider, the Settings / Help & Support links, then the
// account card + dark/light toggle (SidebarAccount). Rendering it from one place
// guarantees the bottom of the navigation is pixel-identical across all pages
// and tiers. Pinned to the bottom (shrink-0) as a sibling of the scrollable nav.
import { SIDEBAR_FOOTER_NAV } from '@/lib/constants/navigation';
import { NavEntry } from './nav-shared';
import { SidebarAccount } from './sidebar-account';

export function SidebarFooter() {
  return (
    <div className="shrink-0 space-y-3 border-t border-border/50 px-3 pb-5 pt-3 xl:px-4">
      <div className="space-y-0.5">
        {SIDEBAR_FOOTER_NAV.map((item) => (
          <NavEntry key={item.href} item={item} variant="list" locked={false} onLocked={() => {}} />
        ))}
      </div>
      <SidebarAccount />
    </div>
  );
}
