'use client';

import { useMemo, useState } from 'react';
import { ShieldCheck, Trash2, MapPin } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Avatar } from '@/components/ui/avatar';
import { ErrorState, SkeletonList, EmptyState } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';
import { CHECK_IN_STATUS, relTime } from '@/lib/family/safety';

type CheckIn = Tables<'safety_check_ins'>;

const ORDER = ['safe', 'on_my_way', 'arrived', 'need_help'] as const;

export function CheckInView() {
  const { familyId, userId, members, selfMember } = useApp();
  const { success, error: toastError } = useToast();
  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  const { data: rows, loading, error, refresh } = useRealtimeQuery<CheckIn>({
    table: 'safety_check_ins', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('safety_check_ins').select('*').eq('family_id', familyId).order('created_at', { ascending: false }).limit(100),
  });

  const [place, setPlace] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  async function checkIn(status: string) {
    setBusy(status);
    // Best-effort: attach the device's current coordinates if the user allows it.
    let coords: { latitude: number; longitude: number } | null = null;
    try {
      coords = await new Promise((resolve) => {
        if (!navigator.geolocation) return resolve(null);
        navigator.geolocation.getCurrentPosition(
          (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude }),
          () => resolve(null), { timeout: 4000 },
        );
      });
    } catch { /* ignore */ }
    const { error } = await createClient().from('safety_check_ins').insert({
      family_id: familyId, member_id: selfMember?.id ?? null, status,
      place_label: place.trim() || null, note: note.trim() || null,
      latitude: coords?.latitude ?? null, longitude: coords?.longitude ?? null, created_by: userId,
    });
    setBusy(null);
    if (error) return toastError(error.message);
    success('Checked in');
    setPlace(''); setNote('');
  }

  async function remove(id: string) {
    const { error } = await createClient().from('safety_check_ins').delete().eq('id', id);
    if (error) toastError(error.message);
  }

  return (
    <div className="module-page">
      <PageHeader title="Check In" description="Let everyone know you're safe with one tap." />

      {/* Composer */}
      <div className="rounded-2xl border border-border bg-surface/40 p-4 sm:p-5">
        <div className="mb-3 grid gap-2 sm:grid-cols-2">
          <Input value={place} onChange={(e) => setPlace(e.target.value)} placeholder="Where are you? (optional)" />
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note (optional)" />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {ORDER.map((s) => {
            const meta = CHECK_IN_STATUS[s];
            return (
              <button key={s} onClick={() => checkIn(s)} disabled={busy !== null}
                className={cn('flex flex-col items-center gap-1 rounded-xl border border-border p-3 text-sm font-semibold transition hover:border-brand/40 hover:bg-elevated disabled:opacity-50', busy === s && 'opacity-60')}>
                <span className="text-xl">{meta.emoji}</span>
                {meta.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Feed */}
      {loading ? <SkeletonList /> : error ? <ErrorState message="Could not load family check-ins. Refresh and try again." onRetry={refresh} /> : (rows ?? []).length === 0 ? (
        <EmptyState icon={ShieldCheck} title="No check-ins yet" description="Tap a status above to post your first check-in." />
      ) : (
        <div className="space-y-2">
          {(rows ?? []).map((c) => {
            const m = c.member_id ? memberById.get(c.member_id) : null;
            const meta = CHECK_IN_STATUS[c.status] ?? CHECK_IN_STATUS.safe;
            const mine = c.created_by === userId;
            return (
              <div key={c.id} className="group flex items-center gap-3 rounded-xl border border-border bg-surface/40 px-3 py-2.5">
                {m ? <Avatar name={m.display_name} color={m.color} size={36} /> : <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-elevated text-muted"><ShieldCheck className="h-4 w-4" /></span>}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">
                    <span className="font-semibold">{m?.display_name ?? 'Member'}</span>{' '}
                    <span className={cn('rounded-full px-1.5 py-0.5 text-[11px] font-semibold', meta.tint)}>{meta.emoji} {meta.label}</span>
                  </p>
                  <p className="truncate text-xs text-muted">
                    {[c.place_label, c.note].filter(Boolean).join(' Â· ')}
                    {(c.place_label || c.note) ? ' Â· ' : ''}{relTime(c.created_at)}
                    {c.latitude != null && <a href={`https://maps.google.com/?q=${c.latitude},${c.longitude}`} target="_blank" rel="noreferrer" className="ml-1 inline-flex items-center gap-0.5 text-brand-text"><MapPin className="h-3 w-3" /> map</a>}
                  </p>
                </div>
                {mine && <button onClick={() => remove(c.id)} className="rounded-lg p-1.5 text-muted/40 opacity-0 transition hover:text-danger group-hover:opacity-100" aria-label="Delete"><Trash2 className="h-4 w-4" /></button>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

