'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { isRealtimePublished } from '@/lib/realtime/published-tables';
import type { Tables } from '@/lib/database.types';

type Subscription = Tables<'subscriptions'>;
type Owner = { familyId: string; userId: string };
type ReadState =
  | { owner: Owner; status: 'loading' | 'unavailable'; subscription: null }
  | { owner: Owner; status: 'ready'; subscription: Subscription | null };
type Lifetime = { owner: Owner; generation: number; ready: boolean };

/** Billing decisions require a successful read for the current family and user. */
export function useBillingSubscription(familyId: string, userId: string) {
  // A fresh identity also separates A -> B -> A from the first A's pending read.
  const owner = useMemo(() => ({ familyId, userId }), [familyId, userId]);
  // Retained handlers must stop working as soon as another owner renders, even
  // before passive cleanup invalidates the old request lifetime.
  const renderedOwner = useRef(owner);
  renderedOwner.current = owner;
  const [read, setRead] = useState<ReadState>({ owner, status: 'loading', subscription: null });
  const active = useRef<Lifetime | null>(null);

  const reload = useCallback(async () => {
    const lifetime = active.current;
    if (!lifetime || lifetime.owner !== owner || renderedOwner.current !== owner) return;
    const generation = ++lifetime.generation;
    lifetime.ready = false;
    setRead({ owner, status: 'loading', subscription: null });
    const isCurrent = () => renderedOwner.current === owner && active.current === lifetime && lifetime.generation === generation;
    try {
      if (!familyId || !userId) throw new Error('Missing subscription owner');
      const { data, error } = await createClient()
        .from('subscriptions').select('*').eq('family_id', familyId).maybeSingle();
      if (!isCurrent()) return;
      if (error || (data && data.family_id !== familyId)) {
        setRead({ owner, status: 'unavailable', subscription: null });
        return;
      }
      lifetime.ready = true;
      setRead({ owner, status: 'ready', subscription: data });
    } catch {
      if (isCurrent()) setRead({ owner, status: 'unavailable', subscription: null });
    }
  }, [familyId, userId, owner]);

  useEffect(() => {
    const lifetime: Lifetime = { owner, generation: 0, ready: false };
    active.current = lifetime;
    void reload();
    return () => { if (active.current === lifetime) active.current = null; };
  }, [owner, reload]);

  useEffect(() => {
    // Checkout returns through a full navigation. Keep realtime conditional on
    // the publication contract, and dispose pending reads even without a channel.
    if (!isRealtimePublished('subscriptions')) return;
    if (!familyId || !userId) return;
    const sb = createClient();
    const channel = sb.channel(`subscription:${familyId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'subscriptions', filter: `family_id=eq.${familyId}` }, () => { void reload(); })
      .subscribe();
    return () => { void sb.removeChannel(channel); };
  }, [familyId, userId, reload]);

  // Mask the old owner during render, before the next effect has started its read.
  const current = read.owner === owner ? read : { status: 'loading' as const, subscription: null };
  const isCurrentReady = useCallback(() => read.owner === owner && read.status === 'ready'
    && renderedOwner.current === owner && active.current?.owner === owner && active.current.ready, [owner, read]);
  return { status: current.status, subscription: current.subscription, reload, isCurrentReady };
}
