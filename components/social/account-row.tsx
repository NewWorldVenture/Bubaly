'use client';

import { useTransition } from 'react';
import { Loader2, Unplug } from 'lucide-react';
import { disconnectAccountAction } from '@/app/(app)/dashboard/social/actions';
import { PlatformDot } from './platform';
import { Badge } from '@/components/ui/badge';
import type { SocialPlatform } from '@/lib/social/capabilities';

const STATUS_TONE: Record<string, 'success' | 'neutral' | 'danger' | 'warning'> = {
  connected: 'success', pending: 'warning', requires_setup: 'neutral',
  error: 'danger', expired: 'warning', disconnected: 'neutral', revoked: 'danger',
};

export function AccountRow({
  id, platform, name, status, lastError, lastSyncedAt,
}: {
  id: string; platform: SocialPlatform; name: string; status: string; lastError: string | null; lastSyncedAt: string | null;
}) {
  const [pending, start] = useTransition();
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border px-3 py-2.5">
      <PlatformDot platform={platform} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{name}</p>
        <p className="truncate text-xs text-muted">
          {lastSyncedAt ? `Synced ${new Date(lastSyncedAt).toLocaleString()}` : (lastError ?? 'Not yet authorized')}
        </p>
      </div>
      <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{status.replace(/_/g, ' ')}</Badge>
      <button
        type="button"
        disabled={pending}
        onClick={() => start(async () => { await disconnectAccountAction(id); })}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2 text-xs text-muted hover:text-danger disabled:opacity-60"
      >
        {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Unplug className="h-3.5 w-3.5" />} Disconnect
      </button>
    </div>
  );
}
