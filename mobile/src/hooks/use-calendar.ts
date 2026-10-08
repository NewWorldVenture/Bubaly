import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../lib/auth';
import { fetchUpcomingEvents } from '../lib/queries';
import { calendarOwnerKey, type CalendarReply } from '../lib/calendar-core';

/** Calendar results belong to an owner at render time, before effects run. */
export function useCalendar(days: number) {
  const { session, family } = useAuth();
  const owner = session && family ? { userId: session.user.id, familyId: family.familyId, memberId: family.memberId, timezone: family.timezone } : null;
  const key = owner ? JSON.stringify([calendarOwnerKey(owner), days]) : '';
  const current = useRef({ key, owner, epoch: 0 });
  const generation = useRef(0);
  const active = useRef(false);
  const pending = useRef<AbortController | null>(null);
  if (current.current.key !== key) { generation.current++; pending.current?.abort(); current.current = { key, owner, epoch: current.current.epoch + 1 }; }
  else current.current = { ...current.current, owner };
  const [state, setState] = useState<{ key: string; epoch: number; data: CalendarReply | null; error: string | null; loading: boolean }>({ key: '', epoch: -1, data: null, error: null, loading: false });
  const load = useCallback(async () => {
    const snapshot = current.current; const id = ++generation.current;
    pending.current?.abort(); const abort = new AbortController(); pending.current = abort;
    if (!snapshot.owner || !active.current) return;
    setState({ key: snapshot.key, epoch: snapshot.epoch, data: null, error: null, loading: true });
    try {
      const data = await fetchUpcomingEvents(snapshot.owner, days, abort.signal);
      if (active.current && id === generation.current && current.current.key === snapshot.key && current.current.epoch === snapshot.epoch) setState({ key: snapshot.key, epoch: snapshot.epoch, data, error: null, loading: false });
    } catch (error) {
      if (active.current && id === generation.current && current.current.key === snapshot.key && current.current.epoch === snapshot.epoch) setState({ key: snapshot.key, epoch: snapshot.epoch, data: null, error: error instanceof Error ? error.message : 'Calendar unavailable.', loading: false });
    }
  }, [days]);
  useEffect(() => {
    active.current = true; void load();
    // This is a request generation counter, deliberately advanced by cleanup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { active.current = false; generation.current++; pending.current?.abort(); };
  }, [key, load]);
  const own = !!key && state.key === key && state.epoch === current.current.epoch;
  return { ownerKey: JSON.stringify([key, current.current.epoch]), data: own ? state.data : null, error: own ? state.error : null, loading: !!key && (!own || state.loading), refreshing: own && state.loading, refresh: load };
}
