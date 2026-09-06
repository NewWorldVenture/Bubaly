'use client';

import { useMemo, useState } from 'react';
import { Car, Plus, Trash2, Gauge, TrendingDown, Smartphone } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select } from '@/components/ui/input';
import { Avatar } from '@/components/ui/avatar';
import { ErrorState, SkeletonList, EmptyState } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';
import { drivingScore, scoreBand, SCORE_TINT, averageScore, fmtDateTime } from '@/lib/family/safety';
import { useTranslations } from '@/components/i18n/locale-provider';

type Trip = Tables<'driving_trips'>;

export function DrivingSafetyView() {
  const tr = useTranslations();
  const { familyId, userId, members } = useApp();
  const { success, error: toastError } = useToast();
  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  const { data: rows, loading, error, refresh } = useRealtimeQuery<Trip>({
    table: 'driving_trips', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('driving_trips').select('*').eq('family_id', familyId).order('started_at', { ascending: false }).limit(200),
  });

  const trips = useMemo(() => rows ?? [], [rows]);
  const avg = useMemo(() => averageScore(trips.map((t) => t.score)), [trips]);
  const totalMiles = useMemo(() => trips.reduce((s, t) => s + Number(t.distance_miles), 0), [trips]);
  const [form, setForm] = useState(false);

  async function remove(id: string) {
    if (!confirm('Delete this trip?')) return;
    const { error } = await createClient().from('driving_trips').delete().eq('id', id);
    if (error) toastError(error.message); else success('Deleted');
  }

  return (
    <div className="module-page">
      <PageHeader title={tr('drivingSafety.drivingSafety')} description="Track trips and driving scores for teen and family drivers."
        action={<Button onClick={() => setForm(true)}><Plus className="h-4 w-4" /> {tr('drivingSafety.logTrip')}</Button>} />

      {/* Summary */}
      <div className="grid grid-cols-3 gap-3">
        <Stat label={tr('drivingSafety.avgScore')} value={avg != null ? String(avg) : '—'} tint={avg != null ? SCORE_TINT[scoreBand(avg)] : 'text-muted'} icon={Gauge} />
        <Stat label={tr('drivingSafety.trips')} value={String(trips.length)} tint="text-fg" icon={Car} />
        <Stat label={tr('drivingSafety.miles')} value={totalMiles.toLocaleString(undefined, { maximumFractionDigits: 0 })} tint="text-fg" icon={TrendingDown} />
      </div>

      {loading ? <SkeletonList /> : error ? <ErrorState message="Could not load driving trips. Refresh and try again." onRetry={refresh} /> : trips.length === 0 ? (
        <EmptyState icon={Car} title={tr('drivingSafety.noTripsLogged')} description="Log a trip to start tracking driving safety scores."
          action={<Button onClick={() => setForm(true)}><Plus className="h-4 w-4" /> {tr('drivingSafety.logTrip')}</Button>} />
      ) : (
        <div className="space-y-2">
          {trips.map((t) => {
            const m = t.member_id ? memberById.get(t.member_id) : null;
            const band = scoreBand(t.score);
            return (
              <div key={t.id} className="group flex items-center gap-3 rounded-xl border border-border bg-surface/40 px-3 py-3">
                {m ? <Avatar name={m.display_name} color={m.color} size={40} /> : <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-elevated text-muted"><Car className="h-5 w-5" /></span>}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{t.label || `${m?.display_name ?? 'Driver'}'s trip`}</p>
                  <p className="truncate text-xs text-muted">
                    {fmtDateTime(t.started_at)} · {Number(t.distance_miles)} mi · max {t.max_mph} mph
                  </p>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted">
                    <span>{t.hard_brakes} hard brakes</span>
                    <span>{t.rapid_accels} rapid accels</span>
                    {t.phone_use_seconds > 0 && <span className="inline-flex items-center gap-0.5"><Smartphone className="h-3 w-3" /> {t.phone_use_seconds}s phone</span>}
                  </div>
                </div>
                <div className="text-right">
                  <p className={cn('text-2xl font-black tabular-nums', SCORE_TINT[band])}>{t.score}</p>
                  <p className="text-[10px] capitalize text-muted">{band}</p>
                </div>
                <button onClick={() => remove(t.id)} className="rounded-lg p-1.5 text-muted/40 opacity-0 transition hover:text-danger group-hover:opacity-100" aria-label="Delete"><Trash2 className="h-4 w-4" /></button>
              </div>
            );
          })}
        </div>
      )}

      {form && <TripModal members={members} familyId={familyId} userId={userId} onClose={() => setForm(false)} />}
    </div>
  );
}

function Stat({ label, value, tint, icon: Icon }: { label: string; value: string; tint: string; icon: typeof Car }) {
  return (
    <div className="rounded-2xl border border-border bg-surface/40 p-4">
      <div className="mb-1 flex items-center justify-between"><p className="text-xs text-muted">{label}</p><Icon className="h-4 w-4 text-muted" /></div>
      <p className={cn('text-2xl font-black tabular-nums', tint)}>{value}</p>
    </div>
  );
}

function TripModal({ members, familyId, userId, onClose }: { members: Tables<'family_members'>[]; familyId: string; userId: string; onClose: () => void }) {
  const tr = useTranslations();
  const { success, error: toastError } = useToast();
  const [saving, setSaving] = useState(false);
  const [v, setV] = useState({ member_id: '', label: '', distance_miles: '', max_mph: '', hard_brakes: '0', rapid_accels: '0', phone_use_seconds: '0', started_at: new Date().toISOString().slice(0, 16) });

  const num = (x: string) => { const n = parseFloat(x); return Number.isFinite(n) ? n : 0; };
  const preview = drivingScore({ distance_miles: num(v.distance_miles), max_mph: num(v.max_mph), hard_brakes: num(v.hard_brakes), rapid_accels: num(v.rapid_accels), phone_use_seconds: num(v.phone_use_seconds) });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const { error } = await createClient().from('driving_trips').insert({
      family_id: familyId, member_id: v.member_id || null, label: v.label.trim() || null,
      started_at: new Date(v.started_at).toISOString(),
      distance_miles: num(v.distance_miles), max_mph: Math.round(num(v.max_mph)),
      hard_brakes: Math.round(num(v.hard_brakes)), rapid_accels: Math.round(num(v.rapid_accels)),
      phone_use_seconds: Math.round(num(v.phone_use_seconds)), score: preview, created_by: userId,
    });
    setSaving(false);
    if (error) return toastError(error.message);
    success('Trip logged');
    onClose();
  }

  return (
    <Modal open onClose={onClose} title={tr('drivingSafety.logATrip')}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('drivingSafety.driver')}>{(id) => <Select id={id} value={v.member_id} onChange={(e) => setV({ ...v, member_id: e.target.value })}><option value="">—</option>{members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</Select>}</Field>
          <Field label={tr('drivingSafety.when')}>{(id) => <Input id={id} type="datetime-local" value={v.started_at} onChange={(e) => setV({ ...v, started_at: e.target.value })} />}</Field>
        </div>
        <Field label={tr('drivingSafety.label')} hint="Optional">{(id) => <Input id={id} value={v.label} onChange={(e) => setV({ ...v, label: e.target.value })} placeholder="School run" />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('drivingSafety.distanceMi')}>{(id) => <Input id={id} type="number" step="0.1" value={v.distance_miles} onChange={(e) => setV({ ...v, distance_miles: e.target.value })} placeholder="8.4" />}</Field>
          <Field label={tr('drivingSafety.maxSpeedMph')}>{(id) => <Input id={id} type="number" value={v.max_mph} onChange={(e) => setV({ ...v, max_mph: e.target.value })} placeholder="68" />}</Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label={tr('drivingSafety.hardBrakes')}>{(id) => <Input id={id} type="number" value={v.hard_brakes} onChange={(e) => setV({ ...v, hard_brakes: e.target.value })} />}</Field>
          <Field label={tr('drivingSafety.rapidAccels')}>{(id) => <Input id={id} type="number" value={v.rapid_accels} onChange={(e) => setV({ ...v, rapid_accels: e.target.value })} />}</Field>
          <Field label={tr('drivingSafety.phoneSec')}>{(id) => <Input id={id} type="number" value={v.phone_use_seconds} onChange={(e) => setV({ ...v, phone_use_seconds: e.target.value })} />}</Field>
        </div>
        <div className="flex items-center justify-between rounded-xl border border-border bg-elevated/40 px-4 py-3">
          <span className="text-sm text-muted">{tr('drivingSafety.safetyScore')}</span>
          <span className={cn('text-2xl font-black tabular-nums', SCORE_TINT[scoreBand(preview)])}>{preview}</span>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" onClick={onClose}>{tr('drivingSafety.cancel')}</Button>
          <Button type="submit" loading={saving}>{tr('drivingSafety.logTrip')}</Button>
        </div>
      </form>
    </Modal>
  );
}

