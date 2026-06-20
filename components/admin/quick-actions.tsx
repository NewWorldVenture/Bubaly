'use client';
// Quick Actions grid for the admin dashboard. Navigation actions are links;
// "Clear Cache" calls the real revalidate server action with live feedback.
import Link from 'next/link';
import { useTransition, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  UserPlus, Megaphone, DatabaseBackup, ScrollText, ShieldCheck, RefreshCw, Check, Loader2,
} from 'lucide-react';
import { adminClearCacheAction } from '@/app/(app)/admin/actions';

function Tile({ icon: Icon, label, onClick, href }: {
  icon: React.ComponentType<{ className?: string }>; label: string;
  onClick?: () => void; href?: string;
}) {
  const inner = (
    <>
      <span className="grid h-9 w-9 place-items-center rounded-xl bg-brand/15 text-brand">
        <Icon className="h-5 w-5" />
      </span>
      <span className="text-xs font-medium">{label}</span>
    </>
  );
  const klass = 'flex flex-col items-center gap-2 rounded-xl border border-border bg-surface/40 p-3 text-center transition hover:border-brand/40 hover:bg-elevated';
  return href
    ? <Link href={href} className={klass}>{inner}</Link>
    : <button type="button" onClick={onClick} className={klass}>{inner}</button>;
}

export function QuickActions() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [cleared, setCleared] = useState(false);

  return (
    <div className="grid grid-cols-3 gap-2">
      <Tile icon={UserPlus} label="Add New User" href="/admin/users?new=1" />
      <Tile icon={Megaphone} label="Create Announcement" href="/admin/content" />
      <Tile icon={DatabaseBackup} label="System Backup" href="/admin/system" />
      <Tile icon={ScrollText} label="View Audit Logs" href="/admin/audit" />
      <Tile icon={ShieldCheck} label="Manage Roles" href="/admin/security" />
      <Tile
        icon={pending ? Loader2 : cleared ? Check : RefreshCw}
        label={cleared ? 'Cache Cleared' : 'Clear Cache'}
        onClick={() =>
          start(async () => {
            await adminClearCacheAction();
            setCleared(true);
            router.refresh();
            setTimeout(() => setCleared(false), 1500);
          })
        }
      />
    </div>
  );
}
