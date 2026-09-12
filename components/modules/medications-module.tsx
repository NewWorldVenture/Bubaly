'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Pill, Plus, Pencil, Trash2, Check, X, Clock, CalendarClock, Activity,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { isManager } from '@/lib/constants/roles';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Textarea, Field, Select } from '@/components/ui/input';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { SkeletonList, ErrorState, EmptyState } from '@/components/ui/states';
import { PageHeader } from '@/components/app/page-header';
import { AiInsight } from '@/components/ai/ai-insight';
import { cn } from '@/lib/utils/cn';
import {
  dosesForDay, doseSlotInstant, adherenceRate, doseStatusCounts, shortTime, localDateKey,
  DAY_LABELS, type ScheduleLike, type DueDose,
} from '@/lib/medications/adherence';
import type { Tables, DoseStatus } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

type Medication = Tables<'medications'>;
type Schedule = Tables<'medication_schedules'>;
type Dose = Tables<'medication_doses'>;

const WHOLE_FAMILY = '__family__';
const ADHERENCE_WINDOW_DAYS = 30;

const blankMed = { id: '', member_id: '', name: '', dosage: '', instructions: '', is_active: true, refill_on: '', refill_reminder_days: 7 };
const blankSchedule = { time_of_day: '08:00', days_of_week: [0, 1, 2, 3, 4, 5, 6] as number[], starts_on: '', ends_on: '' };

// Refill badge for an active medication. Surfaces what Autopilot already reasons
// about (refill_on) right in the list, within the member-set reminder window.
function refillBadge(refillOn: string | null, remindDays: number | null): { label: string; cls: string } | null {
  if (!refillOn) return null;
  const exp = new Date(`${refillOn}T00:00:00`).getTime();
  if (Number.isNaN(exp)) return null;
  const days = Math.ceil((exp - Date.now()) / 86_400_000);
  const window = Math.max(0, Math.min(90, remindDays ?? 7));
  if (days < 0) return { label: 'Refill overdue', cls: 'bg-rose-500/15 text-rose-400' };
  if (days === 0) return { label: 'Refill today', cls: 'bg-rose-500/15 text-rose-400' };
  if (days <= window) return { label: `Refill in ${days}d`, cls: 'bg-amber-500/15 text-amber-400' };
  return null;
}

function AdherenceRing({ rate, size = 96 }: { rate: number | null; size?: number }) {
  const r = size * 0.4;
  const circ = 2 * Math.PI * r;
  const pct = rate ?? 0;
  const offset = circ * (1 - pct / 100);
  const color = rate == null ? '#64748b' : pct >= 80 ? '#10b981' : pct >= 50 ? '#f59e0b' : '#f43f5e';
  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="rotate-[-90deg]">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={size * 0.1} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={size * 0.1}
          strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 0.8s ease' }} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-xl font-bold text-fg">{rate == null ? '—' : `${rate}%`}</span>
      </div>
    </div>
  );
}

export function MedicationsModule() {
  const t = useTranslations();
  const { familyId, userId, members, role } = useApp();
  const { success, error: toastError } = useToast();
  const canEdit = isManager(role);

  const [memberFilter, setMemberFilter] = useState<string>('all');
  const [medModalOpen, setMedModalOpen] = useState(false);
  const [medForm, setMedForm] = useState(blankMed);
  const [scheduleFor, setScheduleFor] = useState<Medication | null>(null);
  const [scheduleForm, setScheduleForm] = useState(blankSchedule);
  const [busy, setBusy] = useState<string | null>(null);
  const savingMed = busy === 'medication';
  const savingSchedule = busy === 'schedule';
  const [dayKey, setDayKey] = useState(() => localDateKey(new Date()));
  const owner = useMemo(() => ({ active: false, pending: false, familyId, userId, role }), [familyId, userId, role]);
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  // Keep the synchronous write guard until React commits the readback and the
  // released busy state together; a queued callback must see the new rows.
  useLayoutEffect(() => { if (busy === null) owner.pending = false; });

  useEffect(() => {
    owner.active = true;
    setBusy(null);
    setMemberFilter('all');
    setMedModalOpen(false);
    setMedForm(blankMed);
    setScheduleFor(null);
    setScheduleForm(blankSchedule);
    return () => { owner.active = false; };
  }, [owner]);

  useEffect(() => {
    const updateDay = () => setDayKey(localDateKey(new Date()));
    const timer = window.setInterval(updateDay, 60_000);
    window.addEventListener('focus', updateDay);
    window.addEventListener('online', updateDay);
    document.addEventListener('visibilitychange', updateDay);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', updateDay);
      window.removeEventListener('online', updateDay);
      document.removeEventListener('visibilitychange', updateDay);
    };
  }, []);

  // Adherence window lower bound (ISO) for the dose log query.
  const windowStart = useMemo(() => {
    const d = new Date(`${dayKey}T00:00:00`);
    d.setDate(d.getDate() - ADHERENCE_WINDOW_DAYS);
    return d.toISOString();
  }, [dayKey]);

  // ── Data ──────────────────────────────────────────────────
  const { data: meds, loading: medsLoading, error: medsError, refresh: refreshMeds, stale: medsStale } = useRealtimeQuery<Medication>({
    table: 'medications', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('medications').select('*').eq('family_id', familyId).order('is_active', { ascending: false }).order('name'),
  });
  const { data: schedules, loading: schedulesLoading, error: schedulesError, refresh: refreshSchedules, stale: schedulesStale } = useRealtimeQuery<Schedule>({
    table: 'medication_schedules', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('medication_schedules').select('*').eq('family_id', familyId).order('time_of_day'),
  });
  const { data: doses, loading: dosesLoading, error: dosesError, refresh: refreshDoses, stale: dosesStale } = useRealtimeQuery<Dose>({
    table: 'medication_doses', familyId, deps: [familyId, dayKey],
    fetcher: (sb) => sb.from('medication_doses').select('*').eq('family_id', familyId).gte('scheduled_for', windowStart),
  });
  const loading = medsLoading || schedulesLoading || dosesLoading;
  const readError = medsError || schedulesError || dosesError;
  const verified = !loading && !readError && !medsStale && !schedulesStale && !dosesStale;
  const latest = useRef({ meds, schedules, doses, verified, dayKey, members });
  latest.current = { meds, schedules, doses, verified, dayKey, members };
  const isCurrent = () => owner.active && currentOwner.current === owner;
  const canMutate = (manager = false) => isCurrent() && !owner.pending && latest.current.verified && (!manager || canEdit);
  const refreshAll = async () => { await Promise.all([refreshMeds(), refreshSchedules(), refreshDoses()]); };

  async function mutate(key: string, manager: boolean, write: () => PromiseLike<{ error: unknown }>,
    readback: () => Promise<void>, complete?: () => void) {
    if (!canMutate(manager)) return;
    owner.pending = true;
    setBusy(key);
    try {
      const { error } = await write();
      if (error) throw error;
      if (!isCurrent()) return;
      await readback();
      if (isCurrent()) complete?.();
    } catch (error) {
      if (!isCurrent()) return;
      // A conflict or lost response can follow another writer's successful
      // action. Read back before allowing the next toggle against this slot.
      await readback();
      if (isCurrent()) toastError(key.startsWith('dose:') && (error as { code?: string } | null)?.code === '23505'
        ? t('medicationsModule.doseChanged') : describeDbError(error));
    } finally {
      if (isCurrent()) setBusy(null);
      else owner.pending = false;
    }
  }

  const memberName = (id: string | null) => members.find((m) => m.id === id)?.display_name ?? null;

  const visibleMeds = useMemo(() => {
    const list = meds ?? [];
    if (memberFilter === 'all') return list;
    if (memberFilter === WHOLE_FAMILY) return list.filter((m) => !m.member_id);
    return list.filter((m) => m.member_id === memberFilter);
  }, [meds, memberFilter]);

  const medIdSet = useMemo(() => new Set(visibleMeds.map((m) => m.id)), [visibleMeds]);

  // Schedules for the currently-visible meds, as the pure helper's shape.
  const scheduleLikes = useMemo<(ScheduleLike & { medMemberId: string | null })[]>(() =>
    (schedules ?? [])
      .filter((s) => s.family_id === familyId && medIdSet.has(s.medication_id)
        && meds.some((m) => m.id === s.medication_id && m.family_id === familyId && m.is_active))
      .map((s) => ({
        id: s.id, medication_id: s.medication_id, time_of_day: s.time_of_day,
        days_of_week: s.days_of_week, starts_on: s.starts_on, ends_on: s.ends_on,
        medMemberId: (meds ?? []).find((m) => m.id === s.medication_id)?.member_id ?? null,
      })),
    [schedules, medIdSet, meds, familyId]);

  const today = useMemo(() => new Date(`${dayKey}T12:00:00`), [dayKey]);
  const todayDoses = useMemo(
    () => dosesForDay(scheduleLikes, doses.filter((d) => d.family_id === familyId
      && meds.some((m) => m.id === d.medication_id && m.member_id === d.member_id))
      .map((d) => ({ schedule_id: d.schedule_id, scheduled_for: d.scheduled_for, status: d.status })), today),
    [scheduleLikes, doses, today, meds, familyId],
  );

  const windowDoseLogs = useMemo(() => {
    const visibleMedIds = new Set(visibleMeds.map((m) => m.id));
    return (doses ?? []).filter((d) => visibleMedIds.has(d.medication_id)).map((d) => ({ status: d.status }));
  }, [doses, visibleMeds]);
  const adherence = adherenceRate(windowDoseLogs);
  const counts = doseStatusCounts(windowDoseLogs);

  const medById = useMemo(() => new Map((meds ?? []).map((m) => [m.id, m])), [meds]);

  // ── Dose logging ──────────────────────────────────────────
  async function logDose(due: DueDose, status: DoseStatus) {
    if (!canMutate()) return;
    const currentDay = localDateKey(new Date());
    if (latest.current.dayKey !== currentDay || !due.slotKey.startsWith(`${currentDay}T`)) {
      setDayKey(currentDay);
      return;
    }
    const med = latest.current.meds.find((m) => m.id === due.medicationId && m.family_id === familyId && m.is_active);
    const schedule = latest.current.schedules.find((s) => s.id === due.scheduleId && s.medication_id === med?.id && s.family_id === familyId);
    const currentSlot = schedule && dosesForDay([schedule], [], new Date()).find((slot) => slot.slotKey === due.slotKey);
    if (!med || !currentSlot || (med.member_id && !latest.current.members.some((m) => m.id === med.member_id && m.family_id === familyId))) {
      toastError(t('medicationsModule.doseChanged'));
      return;
    }
    const scheduledFor = doseSlotInstant(due.slotKey);
    if (!scheduledFor) return;

    // Find the exact unique slot, preserving a prior dose if its schedule time
    // changed during this day.
    const existing = latest.current.doses.find(
      (x) => x.schedule_id === due.scheduleId && new Date(x.scheduled_for).getTime() === new Date(scheduledFor).getTime(),
    );
    if (existing && (existing.family_id !== familyId || existing.medication_id !== med.id || existing.member_id !== med.member_id)) {
      toastError(t('medicationsModule.doseChanged'));
      return;
    }
    await mutate(`dose:${due.scheduleId}:${due.slotKey}`, false, () => {
      const sb = createClient();
      if (existing?.status === status) {
        return sb.from('medication_doses').delete().eq('id', existing.id).eq('family_id', familyId)
          .eq('medication_id', med.id).eq('scheduled_for', existing.scheduled_for).eq('status', existing.status).select('id').single();
      }
      if (existing) return sb.from('medication_doses').update({
        status, taken_at: status === 'taken' ? new Date().toISOString() : null,
      }).eq('id', existing.id).eq('family_id', familyId).eq('medication_id', med.id)
        .eq('scheduled_for', existing.scheduled_for).eq('status', existing.status).select('id').single();
      return sb.from('medication_doses').insert({
        family_id: familyId, medication_id: med.id, schedule_id: due.scheduleId,
        member_id: med.member_id, scheduled_for: scheduledFor, status,
        taken_at: status === 'taken' ? new Date().toISOString() : null, logged_by: userId,
      });
    }, refreshDoses, () => { if (status === 'taken' && existing?.status !== status) success(t('medicationsModule.doseLogged')); });
  }

  // ── Medication CRUD ───────────────────────────────────────
  function openNewMed() { if (canMutate(true)) { setMedForm(blankMed); setMedModalOpen(true); } }
  function openEditMed(m: Medication) {
    if (!canMutate(true) || m.family_id !== familyId) return;
    setMedForm({ id: m.id, member_id: m.member_id ?? '', name: m.name, dosage: m.dosage ?? '', instructions: m.instructions ?? '', is_active: m.is_active, refill_on: m.refill_on ?? '', refill_reminder_days: m.refill_reminder_days ?? 7 });
    setMedModalOpen(true);
  }

  async function saveMed(e: React.FormEvent) {
    e.preventDefault();
    if (!canMutate(true)) return;
    if (medForm.id && !latest.current.meds.some((m) => m.id === medForm.id && m.family_id === familyId)) return;
    if (medForm.member_id && !latest.current.members.some((m) => m.id === medForm.member_id && m.family_id === familyId)) return;
    if (!medForm.name.trim()) { toastError(t('medicationsModule.nameIsRequired')); return; }
    const fields = {
      member_id: medForm.member_id || null,
      name: medForm.name.trim(),
      dosage: medForm.dosage.trim() || null,
      instructions: medForm.instructions.trim() || null,
      is_active: medForm.is_active,
      refill_on: medForm.refill_on || null,
      refill_reminder_days: Math.max(0, Math.min(90, Number(medForm.refill_reminder_days) || 0)),
    };
    await mutate('medication', true, () => medForm.id
      ? createClient().from('medications').update(fields).eq('id', medForm.id).eq('family_id', familyId).select('id').single()
      : createClient().from('medications').insert({ ...fields, family_id: familyId, created_by: userId }), refreshAll, () => {
      success(medForm.id ? 'Medication updated' : 'Medication added');
      setMedModalOpen(false);
    });
  }

  async function deleteMed(m: Medication) {
    if (!canMutate(true) || !latest.current.meds.some((item) => item.id === m.id && item.family_id === familyId)) return;
    if (!confirm(`Delete ${m.name}? This also removes its schedules and dose history.`)) return;
    await mutate('remove-medication', true, () => createClient().from('medications').delete().eq('id', m.id).eq('family_id', familyId).select('id').single(),
      refreshAll, () => success(t('medicationsModule.medicationDeleted')));
  }

  async function toggleActive(m: Medication) {
    const current = latest.current.meds.find((item) => item.id === m.id && item.family_id === familyId);
    if (!canMutate(true) || !current) return;
    await mutate('active', true, () => createClient().from('medications').update({ is_active: !current.is_active }).eq('id', current.id).eq('family_id', familyId).select('id').single(), refreshAll);
  }

  // ── Schedule CRUD ─────────────────────────────────────────
  function openSchedule(m: Medication) {
    if (!canMutate(true) || m.family_id !== familyId) return;
    setScheduleFor(m); setScheduleForm({ ...blankSchedule, starts_on: localDateKey(new Date()) });
  }

  async function saveSchedule(e: React.FormEvent) {
    e.preventDefault();
    if (!canMutate(true) || !scheduleFor || !latest.current.meds.some((m) => m.id === scheduleFor.id && m.family_id === familyId)) return;
    if (scheduleForm.days_of_week.length === 0) { toastError(t('medicationsModule.pickAtLeastOneDay')); return; }
    await mutate('schedule', true, () => createClient().from('medication_schedules').insert({
      family_id: familyId, medication_id: scheduleFor.id,
      time_of_day: scheduleForm.time_of_day,
      days_of_week: scheduleForm.days_of_week,
      starts_on: scheduleForm.starts_on,
      ends_on: scheduleForm.ends_on || null,
    }), refreshAll, () => {
      success(t('medicationsModule.scheduleAdded'));
      setScheduleFor(null);
    });
  }

  async function deleteSchedule(id: string) {
    if (!canMutate(true) || !latest.current.schedules.some((s) => s.id === id && s.family_id === familyId)) return;
    await mutate('remove-schedule', true, () => createClient().from('medication_schedules').delete().eq('id', id).eq('family_id', familyId).select('id').single(), refreshAll);
  }
  function closeMed() { if (!owner.pending) setMedModalOpen(false); }
  function closeSchedule() { if (!owner.pending) setScheduleFor(null); }

  function toggleDay(day: number) {
    setScheduleForm((f) => ({
      ...f,
      days_of_week: f.days_of_week.includes(day) ? f.days_of_week.filter((d) => d !== day) : [...f.days_of_week, day].sort(),
    }));
  }

  const schedulesByMed = useMemo(() => {
    const map = new Map<string, Schedule[]>();
    for (const s of schedules ?? []) {
      const arr = map.get(s.medication_id) ?? [];
      arr.push(s); map.set(s.medication_id, arr);
    }
    return map;
  }, [schedules]);

  if (readError) return <ErrorState message={t('medicationsModule.couldNotLoadMedicationData')} onRetry={() => { void refreshMeds(); void refreshSchedules(); void refreshDoses(); }} />;
  if (!verified) return <SkeletonList count={5} />;

  return (
    <div>
      <PageHeader
        title={t('medications.medications')}
        description={t('medicationsModule.trackMedicationsDosingSchedulesAnd')}
        action={
          <div className="flex items-center gap-2">
            <AiInsight kind="medications" />
            {canEdit && <Button onClick={openNewMed} disabled={!!busy} className="gap-1.5"><Plus className="h-4 w-4" /> {t('medications.addMedication')}</Button>}
          </div>
        }
      />

      {/* Summary: today's doses + adherence */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <div className="lg:col-span-2 rounded-2xl bg-surface/50 border border-border p-5">
          <h2 className="text-sm font-semibold text-fg uppercase tracking-wider mb-4 flex items-center gap-2">
            <Clock className="h-4 w-4 text-brand-text" /> {t('medications.todayAposSDoses')}
          </h2>
          {todayDoses.length === 0 ? (
            <p className="text-muted text-sm py-6 text-center">{t('medications.noDosesScheduledForToday')}</p>
          ) : (
            <ul className="space-y-2">
              {todayDoses.map((due) => {
                const med = medById.get(due.medicationId);
                if (!med) return null;
                const key = due.scheduleId + due.slotKey;
                const instant = doseSlotInstant(due.slotKey);
                const targetUnavailable = !instant || (med.member_id && !members.some((member) => member.id === med.member_id && member.family_id === familyId))
                  || doses.some((dose) => dose.schedule_id === due.scheduleId && new Date(dose.scheduled_for).getTime() === new Date(instant).getTime()
                    && (dose.medication_id !== med.id || dose.member_id !== med.member_id));
                return (
                  <li key={key} className={cn(
                    'flex items-center gap-3 rounded-xl border px-3 py-2.5 transition',
                    due.status === 'taken' ? 'border-emerald-500/30 bg-emerald-500/5'
                      : due.status === 'skipped' ? 'border-amber-500/30 bg-amber-500/5'
                      : 'border-border bg-surface/40',
                  )}>
                    <div className="w-14 text-sm font-semibold text-fg tabular-nums">{due.time}</div>
                    <Pill className="h-4 w-4 text-brand-text flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-fg truncate">
                        {med.name}{med.dosage ? <span className="text-muted font-normal"> · {med.dosage}</span> : null}
                      </div>
                      {memberName(med.member_id) && <div className="text-xs text-muted">{memberName(med.member_id)}</div>}
                      {targetUnavailable && <p className="text-xs text-warning">{t('medicationsModule.doseChanged')}</p>}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button onClick={() => logDose(due, 'taken')} disabled={!!busy || !!targetUnavailable}
                        aria-label={t('medications.markTaken')}
                        className={cn('inline-flex h-8 w-8 items-center justify-center rounded-lg border transition',
                          due.status === 'taken' ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-border text-muted hover:text-emerald-400 hover:border-emerald-500/50')}>
                        <Check className="h-4 w-4" />
                      </button>
                      <button onClick={() => logDose(due, 'skipped')} disabled={!!busy || !!targetUnavailable}
                        aria-label={t('medications.skipDose')}
                        className={cn('inline-flex h-8 w-8 items-center justify-center rounded-lg border transition',
                          due.status === 'skipped' ? 'border-amber-500 bg-amber-500 text-white' : 'border-border text-muted hover:text-amber-400 hover:border-amber-500/50')}>
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="rounded-2xl bg-surface/50 border border-border p-5 flex flex-col items-center justify-center text-center">
          <h2 className="text-sm font-semibold text-fg uppercase tracking-wider mb-3 flex items-center gap-2">
            <Activity className="h-4 w-4 text-emerald-400" /> {t('medications.adherence')}
          </h2>
          <AdherenceRing rate={adherence} />
          <p className="text-xs text-muted mt-3">{t('medications.last')} {ADHERENCE_WINDOW_DAYS} days</p>
          <div className="flex gap-3 mt-3 text-xs">
            <span className="text-emerald-400">{counts.taken} taken</span>
            <span className="text-amber-400">{counts.skipped} skipped</span>
            <span className="text-rose-400">{counts.missed} missed</span>
          </div>
        </div>
      </div>

      {/* Member filter */}
      <div className="flex flex-wrap gap-1.5 mb-4 max-h-28 overflow-y-auto">
        {[{ id: 'all', label: 'All' }, { id: WHOLE_FAMILY, label: 'Whole family' }, ...members.map((m) => ({ id: m.id, label: m.display_name }))].map((opt) => (
          <button key={opt.id} onClick={() => setMemberFilter(opt.id)}
            className={cn('px-3 py-1.5 rounded-lg text-sm font-medium transition',
              memberFilter === opt.id ? 'bg-brand text-white' : 'bg-surface/50 text-muted hover:text-fg border border-border')}>
            {opt.label}
          </button>
        ))}
      </div>

      {/* Medications list */}
      {visibleMeds.length === 0 ? (
        <EmptyState icon={Pill} title={t('medications.noMedicationsYet')}
          description={canEdit ? 'Add a medication and set its dosing schedule to start tracking adherence.' : 'No medications have been added for this filter.'}
          action={canEdit && <Button onClick={openNewMed} disabled={!!busy} className="gap-1.5"><Plus className="h-4 w-4" /> {t('medications.addMedication')}</Button>} />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {visibleMeds.map((m) => {
            const medSchedules = schedulesByMed.get(m.id) ?? [];
            return (
              <div key={m.id} className={cn('rounded-2xl border p-5', m.is_active ? 'bg-surface/50 border-border' : 'bg-surface/20 border-border/50 opacity-70')}>
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="mt-0.5 inline-flex h-9 w-9 items-center justify-center rounded-xl bg-brand/10 text-brand-text flex-shrink-0">
                      <Pill className="h-5 w-5" />
                    </div>
                    <div className="min-w-0">
                      <div className="font-semibold text-fg truncate flex items-center gap-2">
                        {m.name}
                        {!m.is_active && <span className="text-[10px] uppercase tracking-wide text-muted border border-border rounded px-1.5 py-0.5">{t('medications.inactive')}</span>}
                        {m.is_active && (() => {
                          const rb = refillBadge(m.refill_on, m.refill_reminder_days);
                          return rb ? <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold', rb.cls)}>{rb.label}</span> : null;
                        })()}
                      </div>
                      {m.dosage && <div className="text-sm text-muted">{m.dosage}</div>}
                      {m.member_id && (
                        <div className="mt-1 flex items-center gap-1.5">
                          <Avatar name={memberName(m.member_id) ?? '?'} size={16} />
                          <span className="text-xs text-muted">{memberName(m.member_id)}</span>
                        </div>
                      )}
                    </div>
                  </div>
                  {canEdit && (
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button onClick={() => openEditMed(m)} disabled={!!busy} aria-label={t('medications.edit')} className="p-1.5 rounded-lg text-muted hover:text-fg hover:bg-elevated"><Pencil className="h-4 w-4" /></button>
                      <button onClick={() => deleteMed(m)} disabled={!!busy} aria-label={t('medications.delete')} className="p-1.5 rounded-lg text-muted hover:text-rose-400 hover:bg-elevated"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  )}
                </div>

                {m.instructions && <p className="text-sm text-fg/80 mb-3">{m.instructions}</p>}

                <div className="space-y-1.5">
                  {medSchedules.length === 0 ? (
                    <p className="text-xs text-muted">{t('medications.noScheduleSet')}</p>
                  ) : medSchedules.map((s) => (
                    <div key={s.id} className="flex items-center gap-2 text-xs rounded-lg bg-surface/40 border border-border px-2.5 py-1.5">
                      <CalendarClock className="h-3.5 w-3.5 text-brand-text flex-shrink-0" />
                      <span className="font-medium text-fg tabular-nums">{shortTime(s.time_of_day)}</span>
                      <span className="text-muted">
                        {s.days_of_week.length === 7 ? 'Every day' : s.days_of_week.map((d) => DAY_LABELS[d]).join(', ')}
                      </span>
                      {canEdit && (
                        <button onClick={() => deleteSchedule(s.id)} disabled={!!busy} aria-label={t('medications.removeSchedule')} className="ml-auto p-0.5 rounded text-muted hover:text-rose-400"><X className="h-3.5 w-3.5" /></button>
                      )}
                    </div>
                  ))}
                </div>

                {canEdit && (
                  <div className="mt-3 flex items-center gap-3">
                    <button onClick={() => openSchedule(m)} disabled={!!busy} className="text-xs font-medium text-brand-text hover:underline inline-flex items-center gap-1">
                      <Plus className="h-3.5 w-3.5" /> {t('medications.addSchedule')}
                    </button>
                    <button onClick={() => toggleActive(m)} disabled={!!busy} className="text-xs font-medium text-muted hover:text-fg">
                      {m.is_active ? 'Mark inactive' : 'Reactivate'}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Medication modal */}
      <Modal open={medModalOpen} onClose={closeMed} title={medForm.id ? 'Edit medication' : 'Add medication'}>
        <form onSubmit={saveMed} className="space-y-4">
          <fieldset disabled={!!busy} className="space-y-4">
          <Field label={t('medications.name')} required>
            {(id) => <Input id={id} value={medForm.name} onChange={(e) => setMedForm((f) => ({ ...f, name: e.target.value }))} placeholder={t('medications.eGAmoxicillin')} autoFocus />}
          </Field>
          <Field label={t('medications.dosage')}>
            {(id) => <Input id={id} value={medForm.dosage} onChange={(e) => setMedForm((f) => ({ ...f, dosage: e.target.value }))} placeholder={t('medications.eG500Mg1Tablet')} />}
          </Field>
          <Field label="For">
            {(id) => (
              <Select id={id} value={medForm.member_id} onChange={(e) => setMedForm((f) => ({ ...f, member_id: e.target.value }))}>
                <option value="">{t('medications.wholeFamily')}</option>
                {members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
              </Select>
            )}
          </Field>
          <Field label={t('medications.instructions')}>
            {(id) => <Textarea id={id} value={medForm.instructions} onChange={(e) => setMedForm((f) => ({ ...f, instructions: e.target.value }))} placeholder={t('medications.eGTakeWithFood')} />}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('medications.refillDue')} hint={t('medicationsModule.bubalyRemindsYouBeforeIt')}>
              {(id) => <Input id={id} type="date" value={medForm.refill_on} onChange={(e) => setMedForm((f) => ({ ...f, refill_on: e.target.value }))} />}
            </Field>
            <Field label={t('medications.remindDaysAhead')}>
              {(id) => <Input id={id} type="number" min={0} max={90} value={medForm.refill_reminder_days} onChange={(e) => setMedForm((f) => ({ ...f, refill_reminder_days: Number(e.target.value) }))} />}
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm text-fg">
            <input type="checkbox" checked={medForm.is_active} onChange={(e) => setMedForm((f) => ({ ...f, is_active: e.target.checked }))} className="h-4 w-4 rounded border-border" />
            {t('medications.active')}
          </label>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={closeMed} disabled={!!busy}>{t('medications.cancel')}</Button>
            <Button type="submit" disabled={!!busy}>{savingMed ? 'Saving…' : medForm.id ? 'Save changes' : 'Add medication'}</Button>
          </div>
          </fieldset>
        </form>
      </Modal>

      {/* Schedule modal */}
      <Modal open={!!scheduleFor} onClose={closeSchedule} title={`Add schedule${scheduleFor ? ` · ${scheduleFor.name}` : ''}`}>
        <form onSubmit={saveSchedule} className="space-y-4">
          <fieldset disabled={!!busy} className="space-y-4">
          <Field label={t('medications.timeOfDay')} required>
            {(id) => <Input id={id} type="time" value={scheduleForm.time_of_day} onChange={(e) => setScheduleForm((f) => ({ ...f, time_of_day: e.target.value }))} />}
          </Field>
          <div>
            <span className="block text-sm font-medium text-fg mb-1.5">{t('medications.days')}</span>
            <div className="flex flex-wrap gap-1.5">
              {DAY_LABELS.map((label, day) => (
                <button key={day} type="button" onClick={() => toggleDay(day)}
                  className={cn('px-2.5 py-1.5 rounded-lg text-xs font-medium border transition',
                    scheduleForm.days_of_week.includes(day) ? 'bg-brand text-white border-brand' : 'bg-surface/50 text-muted border-border hover:text-fg')}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('medications.starts')}>
              {(id) => <Input id={id} type="date" value={scheduleForm.starts_on} onChange={(e) => setScheduleForm((f) => ({ ...f, starts_on: e.target.value }))} />}
            </Field>
            <Field label={t('medications.endsOptional')}>
              {(id) => <Input id={id} type="date" value={scheduleForm.ends_on} onChange={(e) => setScheduleForm((f) => ({ ...f, ends_on: e.target.value }))} />}
            </Field>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={closeSchedule} disabled={!!busy}>{t('medications.cancel')}</Button>
            <Button type="submit" disabled={!!busy}>{savingSchedule ? 'Saving…' : 'Add schedule'}</Button>
          </div>
          </fieldset>
        </form>
      </Modal>
    </div>
  );
}
