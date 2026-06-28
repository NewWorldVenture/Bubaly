'use client';

// Bottom-left account block for the global sidebar (desktop rail + mobile drawer,
// Free + paid). Shows who's signed in — avatar, name, role/tier, email, an access
// badge — with a "View Profile" action, then the dark/light theme toggle. Replaces
// the old "AI Chief of Staff" promo card.
import Link from 'next/link';
import { Avatar } from '@/components/ui/avatar';
import { useApp } from './app-context';
import { ThemeSwitch } from './theme-switch';
import { ROLE_LABELS } from '@/lib/constants/roles';
import { tierLabelForLevel } from '@/lib/constants/plans';

export function SidebarAccount() {
  const { userEmail, selfMember, role, planLevel, isSuperAdmin } = useApp();

  const name = selfMember?.display_name ?? userEmail?.split('@')[0] ?? 'You';
  const roleLine = isSuperAdmin
    ? 'Super Administrator'
    : `${ROLE_LABELS[role]} · ${tierLabelForLevel(planLevel)}`;

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-border bg-surface/40 p-4">
        <div className="flex items-center gap-3">
          <Avatar name={name} color={selfMember?.color} size={40} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{name}</p>
            <p className="truncate text-xs font-medium text-brand">{roleLine}</p>
          </div>
        </div>

        {userEmail && <p className="mt-2.5 truncate text-xs text-muted">{userEmail}</p>}

        <span
          className={
            isSuperAdmin
              ? 'mt-2.5 inline-flex items-center rounded-full bg-emerald-500/15 px-2.5 py-1 text-[11px] font-semibold text-emerald-300'
              : 'mt-2.5 inline-flex items-center rounded-full bg-brand/15 px-2.5 py-1 text-[11px] font-semibold text-brand'
          }
        >
          {isSuperAdmin ? 'Full Access' : tierLabelForLevel(planLevel)}
        </span>

        <Link
          href="/dashboard/profile"
          className="mt-3 flex w-full items-center justify-center rounded-xl border border-border px-4 py-2.5 text-sm font-semibold text-fg transition hover:bg-elevated"
        >
          View Profile
        </Link>
      </div>

      <ThemeSwitch />
    </div>
  );
}
