'use client';

import { useCallback, useMemo, useState } from 'react';
import { Activity, ChevronRight, Dumbbell, Heart, Plus, Sparkles, Zap, Thermometer, CheckCircle2, Trash2, Target, Loader2 } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { Avatar } from '@/components/ui/avatar';
import { SkeletonList, ErrorState, EmptyState } from '@/components/ui/states';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/app/page-header';
import { cn } from '@/lib/utils/cn';
import type { Tables, MetricType } from '@/lib/database.types';
import { useLocale, useTranslations } from '@/components/i18n/locale-provider';

type HealthMetric = Tables<'health_metrics'>;
type WorkoutLog = Tables<'workout_logs'>;
type Appointment = Tables<'appointments'>;
type Reminder = Tables<'reminders'>;
type SymptomLog = Tables<'symptom_logs'>;
type HealthGoal = Tables<'health_goals'>;

const SEVERITY_KEYS = ['', 'healthDashboard.mild', 'healthDashboard.mild', 'healthDashboard.moderate', 'healthDashboard.severe', 'healthDashboard.severe'];
const SEVERITY_COLORS = ['', 'text-emerald-300', 'text-emerald-300', 'text-amber-300', 'text-orange-300', 'text-rose-300'];

const TABS = [
  { value: 'Overview', labelKey: 'healthDashboard.overview' },
  { value: 'Activity', labelKey: 'health.activity' },
  { value: 'Nutrition', labelKey: 'healthDashboard.nutrition' },
  { value: 'Sleep', labelKey: 'health.sleep' },
  { value: 'Checkups', labelKey: 'healthDashboard.checkups' },
  { value: 'Medications', labelKey: 'healthDashboard.medications' },
  { value: 'Documents', labelKey: 'healthDashboard.documents' },
  { value: 'Vitals', labelKey: 'healthDashboard.vitals' },
] as const;
type Tab = (typeof TABS)[number]['value'];

const METRIC_TYPES: { value: MetricType; label: string; labelKey: string; unit: string; unitKey: string }[] = [
  { value: 'steps', label: 'Steps', labelKey: 'health.steps', unit: 'steps', unitKey: 'healthDashboard.unitSteps' },
  { value: 'sleep_hours', label: 'Sleep', labelKey: 'health.sleep', unit: 'hours', unitKey: 'healthDashboard.unitHours' },
  { value: 'heart_rate', label: 'Heart Rate', labelKey: 'health.heartRate', unit: 'bpm', unitKey: 'healthDashboard.unitBpm' },
  { value: 'calories', label: 'Calories', labelKey: 'health.calories', unit: 'kcal', unitKey: 'healthDashboard.unitKcal' },
  { value: 'active_minutes', label: 'Active Minutes', labelKey: 'healthDashboard.activeMinutes', unit: 'min', unitKey: 'healthDashboard.unitMinutes' },
  { value: 'distance', label: 'Distance', labelKey: 'healthDashboard.distance', unit: 'miles', unitKey: 'healthDashboard.unitMiles' },
  { value: 'weight', label: 'Weight', labelKey: 'healthDashboard.weight', unit: 'lbs', unitKey: 'healthDashboard.unitPounds' },
  { value: 'water_cups', label: 'Water', labelKey: 'healthDashboard.water', unit: 'cups', unitKey: 'healthDashboard.unitCups' },
];

type Translator = ReturnType<typeof useTranslations>;

function todayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function daysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function formatDuration(mins: number | null, locale: string, tr: Translator) {
  if (!mins) return tr('healthDashboard.durationMinutes', { minutes: 0 });
  if (mins < 60) return tr('healthDashboard.durationMinutes', { minutes: mins.toLocaleString(locale) });
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0
    ? tr('healthDashboard.durationHoursMinutes', { hours: h.toLocaleString(locale), minutes: m.toLocaleString(locale) })
    : tr('healthDashboard.durationHours', { hours: h.toLocaleString(locale) });
}

function formatRelativeTime(iso: string, locale: string, tr: Translator) {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / 86400000);
  const time = d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  if (diffDays === 0) return tr('healthDashboard.todayAt', { time });
  if (diffDays === 1) return tr('healthDashboard.yesterdayAt', { time });
  return d.toLocaleString(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const WORKOUT_ICONS: Record<string, string> = {
  run: '🏃', running: '🏃', jog: '🏃',
  swim: '🏊', swimming: '🏊',
  bike: '🚴', cycling: '🚴', biking: '🚴',
  walk: '🚶', walking: '🚶', hike: '🚶', hiking: '🥾',
  yoga: '🧘', pilates: '🧘',
  weights: '🏋️', lifting: '🏋️', gym: '🏋️', strength: '🏋️',
  dance: '💃', basketball: '🏀', soccer: '⚽', tennis: '🎾', golf: '⛳',
};

function workoutIcon(activity: string) {
  const lower = activity.toLowerCase();
  for (const [key, icon] of Object.entries(WORKOUT_ICONS)) {
    if (lower.includes(key)) return icon;
  }
  return '🏅';
}

export function HealthModule() {
  const tr = useTranslations();
  const { code: locale } = useLocale();
  const { familyId, userId, members } = useApp();
  const { success, error: toastError } = useToast();
  const [tab, setTab] = useState<Tab>('Overview');
  const [apptOpen, setApptOpen] = useState(false);
  const [metricOpen, setMetricOpen] = useState(false);
  const [workoutOpen, setWorkoutOpen] = useState(false);
  const [symptomOpen, setSymptomOpen] = useState(false);
  const [goalOpen, setGoalOpen] = useState(false);
  const [coachOpen, setCoachOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const [apptForm, setApptForm] = useState({ title: '', starts_at: '', member_id: '', provider: '', location: '', notes: '' });
  const [metricForm, setMetricForm] = useState({ member_id: '', type: 'steps' as MetricType, value: '', recorded_at: '' });
  const [workoutForm, setWorkoutForm] = useState({ member_id: '', activity: '', duration_minutes: '', calories: '', distance: '', notes: '', recorded_at: '' });
  const [symptomForm, setSymptomForm] = useState({ member_id: '', symptom: '', severity: '3', body_area: '', notes: '', started_at: '' });
  const [goalForm, setGoalForm] = useState({ member_id: '', metric_type: 'steps' as MetricType, target: '', period: 'daily' as 'daily' | 'weekly' });

  // AI Health Coach modal state
  const [coachForm, setCoachForm] = useState({ member_id: '', question: '' });
  const [coachLoading, setCoachLoading] = useState(false);
  const [coachAnswer, setCoachAnswer] = useState('');
  const [coachError, setCoachError] = useState('');

  const now = useMemo(() => new Date().toISOString(), []);
  const weekAgo = useMemo(() => daysAgo(7), []);
  const todayISO = useMemo(() => todayStart(), []);

  // ── Data queries ──────────────────────────────────────────
  const { data: metrics, loading: metricsLoading, error: metricsError, refresh: refreshMetrics } = useRealtimeQuery<HealthMetric>({
    table: 'health_metrics', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('health_metrics').select('*').eq('family_id', familyId).gte('recorded_at', weekAgo).order('recorded_at', { ascending: false }),
  });

  const { data: workouts, loading: workoutsLoading, error: workoutsError, refresh: refreshWorkouts } = useRealtimeQuery<WorkoutLog>({
    table: 'workout_logs', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('workout_logs').select('*').eq('family_id', familyId).order('recorded_at', { ascending: false }).limit(10),
  });

  const { data: appointments, loading: apptLoading, error: apptError, refresh: refreshAppointments } = useRealtimeQuery<Appointment>({
    table: 'appointments', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('appointments').select('*').eq('family_id', familyId).gte('starts_at', now).order('starts_at').limit(6),
  });

  const { data: reminders, loading: remLoading, error: remError, refresh: refreshReminders } = useRealtimeQuery<Reminder>({
    table: 'reminders', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('reminders').select('*').eq('family_id', familyId).eq('is_done', false).limit(4),
  });

  const { data: symptoms, loading: symptomsLoading, error: symptomsError, refresh: refreshSymptoms } = useRealtimeQuery<SymptomLog>({
    table: 'symptom_logs', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('symptom_logs').select('*').eq('family_id', familyId).order('started_at', { ascending: false }).limit(50),
  });

  const { data: goals, loading: goalsLoading, error: goalsError, refresh: refreshGoals } = useRealtimeQuery<HealthGoal>({
    table: 'health_goals', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('health_goals').select('*').eq('family_id', familyId).eq('is_active', true),
  });

  // Per-member goal lookup (`member:metric:period`), with a sensible step fallback.
  const goalMap = useMemo(() => {
    const map = new Map<string, number>();
    goals.forEach((g) => map.set(`${g.member_id}:${g.metric_type}:${g.period}`, g.target));
    return map;
  }, [goals]);
  const stepGoalFor = useMemo(() => (memberId: string) => goalMap.get(`${memberId}:steps:daily`) ?? 10000, [goalMap]);
  const familyStepsGoal = useMemo(
    () => members.reduce((s, m) => s + stepGoalFor(m.id), 0) || 10000,
    [members, stepGoalFor],
  );

  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const loading = metricsLoading || workoutsLoading || apptLoading || remLoading || symptomsLoading || goalsLoading;
  const error = metricsError || workoutsError || apptError || remError || symptomsError || goalsError;
  const refresh = () => { void refreshMetrics(); void refreshWorkouts(); void refreshAppointments(); void refreshReminders(); void refreshSymptoms(); void refreshGoals(); };

  // ── Derived data ──────────────────────────────────────────
  const todayMetrics = useMemo(() => metrics.filter((m) => m.recorded_at >= todayISO), [metrics, todayISO]);

  const totalStepsToday = useMemo(() => todayMetrics.filter((m) => m.type === 'steps').reduce((s, m) => s + m.value, 0), [todayMetrics]);
  const totalCaloriesToday = useMemo(() => todayMetrics.filter((m) => m.type === 'calories').reduce((s, m) => s + m.value, 0), [todayMetrics]);
  const avgSleepToday = useMemo(() => {
    const sleeps = todayMetrics.filter((m) => m.type === 'sleep_hours');
    if (sleeps.length === 0) return 0;
    return sleeps.reduce((s, m) => s + m.value, 0) / sleeps.length;
  }, [todayMetrics]);
  const totalActiveMinToday = useMemo(() => todayMetrics.filter((m) => m.type === 'active_minutes').reduce((s, m) => s + m.value, 0), [todayMetrics]);

  const formatSleepHours = useCallback((h: number) => {
    if (h === 0) return tr('healthDashboard.durationHours', { hours: 0 });
    const hrs = Math.floor(h);
    const mins = Math.round((h - hrs) * 60);
    return mins > 0
      ? tr('healthDashboard.durationHoursMinutes', { hours: hrs.toLocaleString(locale), minutes: mins.toLocaleString(locale) })
      : tr('healthDashboard.durationHours', { hours: hrs.toLocaleString(locale) });
  }, [locale, tr]);

  // Stats grid
  const statsGrid = useMemo(() => [
    { icon: Heart, label: tr('healthDashboard.familyMembers'), value: members.length.toLocaleString(locale), sub: tr('healthDashboard.trackingHealth'), bg: 'bg-rose-600/20 text-rose-300' },
    { icon: Activity, label: tr('healthDashboard.stepsToday'), value: totalStepsToday.toLocaleString(locale), sub: tr('healthDashboard.familyCombined'), bg: 'bg-brand/15 text-brand-text' },
    { icon: Zap, label: tr('healthDashboard.activeCalories'), value: totalCaloriesToday.toLocaleString(locale), sub: tr('healthDashboard.todayCombined'), bg: 'bg-orange-600/20 text-orange-300' },
    { icon: Activity, label: tr('healthDashboard.avgSleep'), value: formatSleepHours(avgSleepToday), sub: tr('healthDashboard.lastNight'), bg: 'bg-blue-600/20 text-blue-300' },
  ], [members.length, totalStepsToday, totalCaloriesToday, avgSleepToday, locale, tr, formatSleepHours]);

  // Activity summary progress bars
  const activityProgress = useMemo(() => [
    { label: tr('health.steps'), val: totalStepsToday.toLocaleString(locale), goal: familyStepsGoal.toLocaleString(locale), pct: Math.min(100, Math.round((totalStepsToday / familyStepsGoal) * 100)) },
    { label: tr('health.calories'), val: totalCaloriesToday.toLocaleString(locale), goal: (2000).toLocaleString(locale), pct: Math.min(100, Math.round((totalCaloriesToday / 2000) * 100)) },
    { label: tr('healthDashboard.activeMinutes'), val: totalActiveMinToday.toLocaleString(locale), goal: (60).toLocaleString(locale), pct: Math.min(100, Math.round((totalActiveMinToday / 60) * 100)) },
  ], [totalStepsToday, totalCaloriesToday, totalActiveMinToday, familyStepsGoal, locale, tr]);

  const goalPct = useMemo(() => {
    if (activityProgress.length === 0) return 0;
    return Math.round(activityProgress.reduce((s, p) => s + p.pct, 0) / activityProgress.length);
  }, [activityProgress]);
  const circ = 251.2;
  const dash = (goalPct / 100) * circ;

  // Weekly bars (last 7 days step totals, normalized)
  const weeklyBars = useMemo(() => {
    const days: { day: string; val: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      d.setHours(0, 0, 0, 0);
      const nextD = new Date(d);
      nextD.setDate(nextD.getDate() + 1);
      const daySteps = metrics
        .filter((m) => m.type === 'steps' && m.recorded_at >= d.toISOString() && m.recorded_at < nextD.toISOString())
        .reduce((s, m) => s + m.value, 0);
      days.push({ day: d.toLocaleDateString(locale, { weekday: 'short' }), val: daySteps });
    }
    const max = Math.max(...days.map((d) => d.val), 1);
    return days.map((d) => ({ ...d, pct: Math.round((d.val / max) * 100) }));
  }, [metrics, locale]);

  // Member stats (steps, sleep, heart rate for today)
  const memberStats = useMemo(() => {
    return members.map((m) => {
      const memberMetrics = todayMetrics.filter((met) => met.member_id === m.id);
      const steps = memberMetrics.filter((met) => met.type === 'steps').reduce((s, met) => s + met.value, 0);
      const sleepArr = memberMetrics.filter((met) => met.type === 'sleep_hours');
      const sleep = sleepArr.length > 0 ? sleepArr.reduce((s, met) => s + met.value, 0) / sleepArr.length : 0;
      const hrArr = memberMetrics.filter((met) => met.type === 'heart_rate');
      const hr = hrArr.length > 0 ? Math.round(hrArr.reduce((s, met) => s + met.value, 0) / hrArr.length) : 0;
      const stepGoalPct = Math.min(100, Math.round((steps / stepGoalFor(m.id)) * 100));
      return { member: m, steps, sleep, hr, pct: stepGoalPct };
    });
  }, [members, todayMetrics, stepGoalFor]);

  // Health summary for sidebar
  const healthSummary = useMemo(() => {
    const allSteps = metrics.filter((m) => m.type === 'steps');
    const avgSteps = allSteps.length > 0 ? Math.round(allSteps.reduce((s, m) => s + m.value, 0) / allSteps.length) : 0;
    const allSleep = metrics.filter((m) => m.type === 'sleep_hours');
    const avgSleep = allSleep.length > 0 ? allSleep.reduce((s, m) => s + m.value, 0) / allSleep.length : 0;
    const totalCals = metrics.filter((m) => m.type === 'calories').reduce((s, m) => s + m.value, 0);
    // Active days = days in the last 7 where at least one active_minutes or steps metric exists
    const activeDaySet = new Set<string>();
    metrics.forEach((m) => {
      if (m.type === 'steps' || m.type === 'active_minutes') {
        activeDaySet.add(m.recorded_at.slice(0, 10));
      }
    });
    return [
      { label: tr('healthDashboard.avgSteps'), value: avgSteps.toLocaleString(locale), sub: tr('healthDashboard.familyAverage'), color: 'text-brand-text' },
      { label: tr('healthDashboard.avgSleep'), value: formatSleepHours(avgSleep), sub: tr('healthDashboard.perNight'), color: 'text-blue-300' },
      { label: tr('healthDashboard.caloriesBurned'), value: totalCals.toLocaleString(locale), sub: tr('healthDashboard.weekTotal'), color: 'text-emerald-300' },
      { label: tr('healthDashboard.activeDays'), value: `${activeDaySet.size.toLocaleString(locale)} / 7`, sub: tr('health.thisWeek'), color: 'text-orange-300' },
    ];
  }, [metrics, locale, tr, formatSleepHours]);

  // Health insights (derived programmatically)
  const insights = useMemo(() => {
    const result: { icon: string; text: string; color: string }[] = [];

    // Check for consecutive step goal days per member
    for (const m of members) {
      const memberStepDays = new Map<string, number>();
      metrics.filter((met) => met.member_id === m.id && met.type === 'steps').forEach((met) => {
        const day = met.recorded_at.slice(0, 10);
        memberStepDays.set(day, (memberStepDays.get(day) || 0) + met.value);
      });
      let consecutive = 0;
      for (let i = 0; i < 7; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const key = d.toISOString().slice(0, 10);
        if ((memberStepDays.get(key) || 0) >= stepGoalFor(m.id)) {
          consecutive++;
        } else break;
      }
      if (consecutive >= 3) {
        result.push({
          icon: '💡',
          text: tr('healthDashboard.stepStreak', { name: m.display_name, count: consecutive.toLocaleString(locale) }),
          color: 'bg-violet-500/15 border-violet-400/20',
        });
      }
    }

    // Sleep improvement check
    const thisWeekSleep = metrics.filter((m) => m.type === 'sleep_hours' && m.recorded_at >= daysAgo(7));
    const avgThisWeek = thisWeekSleep.length > 0 ? thisWeekSleep.reduce((s, m) => s + m.value, 0) / thisWeekSleep.length : 0;
    if (avgThisWeek >= 8) {
      result.push({
        icon: '😴',
        text: tr('healthDashboard.sleepInsight', { duration: formatSleepHours(avgThisWeek) }),
        color: 'bg-blue-500/15 border-blue-400/20',
      });
    }

    // Upcoming appointment reminder
    if (appointments.length > 0) {
      const next = appointments[0];
      const member = next.member_id ? memberById.get(next.member_id) : undefined;
      const daysUntil = Math.ceil((new Date(next.starts_at).getTime() - Date.now()) / 86400000);
      if (daysUntil <= 7) {
        result.push({
          icon: '⚠️',
          text: member
            ? tr(daysUntil === 1 ? 'healthDashboard.memberCheckupDay' : 'healthDashboard.memberCheckupDays', { name: member.display_name, count: daysUntil.toLocaleString(locale), title: next.title })
            : tr(daysUntil === 1 ? 'healthDashboard.checkupDay' : 'healthDashboard.checkupDays', { count: daysUntil.toLocaleString(locale), title: next.title }),
          color: 'bg-orange-500/15 border-orange-400/20',
        });
      }
    }

    // Hydration check
    const todayWater = todayMetrics.filter((m) => m.type === 'water_cups').reduce((s, m) => s + m.value, 0);
    if (todayWater > 0 && todayWater < 8) {
      result.push({
        icon: '💧',
        text: tr(todayWater === 1 ? 'healthDashboard.waterInsightOne' : 'healthDashboard.waterInsight', { count: todayWater.toLocaleString(locale) }),
        color: 'bg-cyan-500/15 border-cyan-400/20',
      });
    }

    if (result.length === 0) {
      result.push({
        icon: '📊',
        text: tr('healthDashboard.insightsEmpty'),
        color: 'bg-violet-500/15 border-violet-400/20',
      });
    }

    return result;
  }, [metrics, todayMetrics, members, appointments, memberById, stepGoalFor, locale, tr, formatSleepHours]);

  // ── CRUD handlers ──────────────────────────────────────────
  async function saveAppointment() {
    if (!apptForm.title || !apptForm.starts_at) return;
    setSaving(true);
    const sb = createClient();
    const { error: err } = await sb.from('appointments').insert({
      family_id: familyId,
      title: apptForm.title,
      starts_at: new Date(apptForm.starts_at).toISOString(),
      member_id: apptForm.member_id || null,
      provider: apptForm.provider.trim() || null,
      location: apptForm.location.trim() || null,
      notes: apptForm.notes || null,
      created_by: userId,
    });
    setSaving(false);
    if (err) { toastError(tr('healthModule.failedToSaveAppointment')); return; }
    success(tr('healthModule.appointmentAdded'));
    setApptOpen(false);
    setApptForm({ title: '', starts_at: '', member_id: '', provider: '', location: '', notes: '' });
  }

  async function saveMetric() {
    if (!metricForm.member_id || !metricForm.value) return;
    setSaving(true);
    const sb = createClient();
    const typeInfo = METRIC_TYPES.find((t) => t.value === metricForm.type);
    const { error: err } = await sb.from('health_metrics').insert({
      family_id: familyId,
      member_id: metricForm.member_id,
      type: metricForm.type,
      value: parseFloat(metricForm.value),
      unit: typeInfo?.unit || null,
      recorded_at: metricForm.recorded_at ? new Date(metricForm.recorded_at).toISOString() : new Date().toISOString(),
    });
    setSaving(false);
    if (err) { toastError(tr('healthModule.failedToLogMetric')); return; }
    success(tr('healthModule.metricLogged'));
    setMetricOpen(false);
    setMetricForm({ member_id: '', type: 'steps', value: '', recorded_at: '' });
  }

  async function saveWorkout() {
    if (!workoutForm.member_id || !workoutForm.activity) return;
    setSaving(true);
    const sb = createClient();
    const { error: err } = await sb.from('workout_logs').insert({
      family_id: familyId,
      member_id: workoutForm.member_id,
      activity: workoutForm.activity,
      duration_minutes: workoutForm.duration_minutes ? parseInt(workoutForm.duration_minutes) : null,
      calories: workoutForm.calories ? parseInt(workoutForm.calories) : null,
      distance: workoutForm.distance ? parseFloat(workoutForm.distance) : null,
      notes: workoutForm.notes || null,
      recorded_at: workoutForm.recorded_at ? new Date(workoutForm.recorded_at).toISOString() : new Date().toISOString(),
      created_by: userId,
    });
    setSaving(false);
    if (err) { toastError(tr('healthModule.failedToLogWorkout')); return; }
    success(tr('healthModule.workoutLogged'));
    setWorkoutOpen(false);
    setWorkoutForm({ member_id: '', activity: '', duration_minutes: '', calories: '', distance: '', notes: '', recorded_at: '' });
  }

  async function saveSymptom() {
    if (!symptomForm.member_id || !symptomForm.symptom.trim()) return;
    setSaving(true);
    const sb = createClient();
    const { error: err } = await sb.from('symptom_logs').insert({
      family_id: familyId,
      member_id: symptomForm.member_id,
      symptom: symptomForm.symptom.trim(),
      severity: parseInt(symptomForm.severity) || 3,
      body_area: symptomForm.body_area.trim() || null,
      notes: symptomForm.notes.trim() || null,
      started_at: symptomForm.started_at ? new Date(symptomForm.started_at).toISOString() : new Date().toISOString(),
      created_by: userId,
    });
    setSaving(false);
    if (err) { toastError(tr('healthModule.failedToLogSymptom')); return; }
    success(tr('healthModule.symptomLogged'));
    setSymptomOpen(false);
    setSymptomForm({ member_id: '', symptom: '', severity: '3', body_area: '', notes: '', started_at: '' });
  }

  async function resolveSymptom(s: SymptomLog) {
    const sb = createClient();
    const { error: err } = await sb.from('symptom_logs').update({ status: 'resolved', ended_at: new Date().toISOString() }).eq('id', s.id);
    if (err) { toastError(tr('healthModule.failedToUpdateSymptom')); return; }
    success(tr('healthModule.markedResolved'));
  }

  async function deleteSymptom(s: SymptomLog) {
    const sb = createClient();
    const { error: err } = await sb.from('symptom_logs').delete().eq('id', s.id);
    if (err) { toastError(tr('healthModule.failedToDeleteSymptom')); return; }
    success(tr('healthModule.symptomRemoved'));
  }

  async function saveGoal() {
    if (!goalForm.member_id || !goalForm.target) return;
    const target = parseFloat(goalForm.target);
    if (!(target > 0)) { toastError(tr('healthModule.targetMustBeGreaterThan')); return; }
    setSaving(true);
    const sb = createClient();
    const typeInfo = METRIC_TYPES.find((t) => t.value === goalForm.metric_type);
    const { error: err } = await sb.from('health_goals').upsert({
      family_id: familyId,
      member_id: goalForm.member_id,
      metric_type: goalForm.metric_type,
      target,
      period: goalForm.period,
      label: typeInfo?.label ?? null,
      is_active: true,
      created_by: userId,
    }, { onConflict: 'member_id,metric_type,period' });
    setSaving(false);
    if (err) { toastError(tr('healthModule.failedToSaveGoal')); return; }
    success(tr('healthModule.goalSaved'));
    setGoalOpen(false);
    setGoalForm({ member_id: '', metric_type: 'steps', target: '', period: 'daily' });
  }

  async function askCoach() {
    if (!coachForm.question.trim()) return;
    setCoachLoading(true);
    setCoachError('');
    setCoachAnswer('');
    try {
      const res = await fetch('/api/ai/health/coach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: coachForm.question.trim(), memberId: coachForm.member_id || null }),
      });
      const json = await res.json();
      if (!res.ok) { setCoachError(json.error || tr('healthDashboard.coachUnavailable')); return; }
      setCoachAnswer(json.text || '');
    } catch {
      setCoachError(tr('healthDashboard.networkError'));
    } finally {
      setCoachLoading(false);
    }
  }

  // Most-recent symptoms first; active ones surfaced to the top.
  const sortedSymptoms = useMemo(() => {
    return [...symptoms].sort((a, b) => {
      if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
      return b.started_at.localeCompare(a.started_at);
    });
  }, [symptoms]);
  const activeSymptomCount = useMemo(() => symptoms.filter((s) => s.status === 'active').length, [symptoms]);

  // ── Loading / Error ──────────────────────────────────────
  if (loading) return <SkeletonList />;
  if (error) return <ErrorState message={tr('healthDashboard.loadError')} onRetry={refresh} />;

  const ACCENT = ['bg-violet-500', 'bg-blue-500', 'bg-emerald-500', 'bg-orange-500'];

  return (
    <div className="module-with-sidebar">
      <div className="module-main space-y-5">
        <PageHeader
          title={tr('health.health')}
          description={tr('healthModule.trackFitnessWellnessAndHealth')}
          action={
            <div className="flex gap-2">
              <Button onClick={() => setMetricOpen(true)} className="btn-cta"><Plus className="h-4 w-4" /> {tr('health.logMetric')}</Button>
              <Button onClick={() => setWorkoutOpen(true)} className="btn-secondary"><Dumbbell className="h-4 w-4" /> {tr('health.logWorkout')}</Button>
            </div>
          }
        />

        {/* Tab bar */}
        <div className="flex items-center justify-between border-b border-border">
          <div className="tab-bar">
            {TABS.map((t) => (
              <button key={t.value} onClick={() => setTab(t.value)} className={cn('tab-item', tab === t.value ? 'tab-item-active' : 'tab-item-inactive')}>{tr(t.labelKey)}</button>
            ))}
          </div>
        </div>

        {/* Stats grid */}
        <div className="grid-stats gap-3">
          {statsGrid.map(({ icon: Icon, label, value, sub, bg }) => (
            <div key={label} className="rounded-2xl border border-border bg-surface/40 p-4">
              <div className={cn('mb-3 grid h-10 w-10 place-items-center rounded-xl', bg)}><Icon className="h-5 w-5" /></div>
              <p className="text-2xl font-black">{value}</p>
              <p className="text-sm font-semibold">{label}</p>
              <p className="text-xs text-muted">{sub}</p>
            </div>
          ))}
        </div>

        {/* Activity Summary + Family Health */}
        <div className="grid gap-5 lg:grid-cols-2">
          {/* Activity Summary */}
          <div className="rounded-2xl border border-border bg-surface/40 p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-semibold">{tr('health.activitySummary')}</h2>
              <button onClick={() => setGoalOpen(true)} className="flex items-center gap-1 text-xs font-semibold text-brand-text"><Target className="h-3 w-3" /> {tr('health.setGoals')}</button>
            </div>
            {metrics.length === 0 ? (
              <EmptyState icon={Activity} title={tr('health.noActivityDataYet')} description={tr('healthModule.logYourFirstHealthMetric')} action={<Button onClick={() => setMetricOpen(true)} className="btn-cta"><Plus className="h-4 w-4" /> {tr('health.logMetric')}</Button>} />
            ) : (
              <>
                <div className="flex items-center gap-6">
                  <div className="relative h-32 w-32 shrink-0">
                    <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
                      <circle cx="50" cy="50" r="40" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="12" />
                      <circle cx="50" cy="50" r="40" fill="none" stroke="url(#healthGrad)" strokeWidth="12" strokeDasharray={`${dash} ${circ}`} strokeLinecap="round" />
                      <defs><linearGradient id="healthGrad" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stopColor="#7c5dff" /><stop offset="100%" stopColor="#34d399" /></linearGradient></defs>
                    </svg>
                    <div className="absolute inset-0 flex flex-col items-center justify-center">
                      <span className="text-2xl font-black">{goalPct}%</span>
                      <span className="text-[10px] text-muted">{tr('health.goalMet')}</span>
                    </div>
                  </div>
                  <div className="space-y-3 flex-1">
                    {activityProgress.map((s) => (
                      <div key={s.label}>
                        <div className="flex justify-between text-xs mb-1">
                          <span className="text-muted">{s.label}</span>
                          <span className="font-semibold">{s.val} / {s.goal}</span>
                        </div>
                        <div className="h-1.5 rounded-full bg-border">
                          <div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-emerald-400" style={{ width: `${s.pct}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="mt-5">
                  <p className="mb-3 text-xs text-muted">{tr('health.thisWeek')}</p>
                  <div className="flex items-end gap-1.5 h-16">
                    {weeklyBars.map(({ day, pct }) => (
                      <div key={day} className="flex flex-1 flex-col items-center gap-1">
                        <div className="w-full rounded-sm bg-gradient-to-t from-violet-600 to-blue-400 opacity-80" style={{ height: `${Math.max(pct, 2)}%` }} />
                        <span className="text-[9px] text-muted/60">{day}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Family Health at a Glance */}
          <div className="rounded-2xl border border-border bg-surface/40 p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-semibold">{tr('health.familyHealthAtAGlance')}</h2>
            </div>
            {memberStats.every((ms) => ms.steps === 0 && ms.sleep === 0 && ms.hr === 0) ? (
              <EmptyState icon={Heart} title={tr('health.noMemberHealthData')} description={tr('healthModule.logMetricsForFamilyMembers')} action={<Button onClick={() => setMetricOpen(true)} className="btn-cta"><Plus className="h-4 w-4" /> {tr('health.logMetric')}</Button>} />
            ) : (
              <div className="max-h-[32rem] space-y-3 overflow-y-auto">
                {memberStats.map(({ member: m, steps, sleep, hr, pct }) => (
                  <div key={m.id} className="rounded-xl border border-border p-3">
                    <div className="flex items-center gap-3 mb-2.5">
                      <Avatar name={m.display_name} color={m.color} size={32} />
                      <div className="flex-1">
                        <p className="text-sm font-semibold">{m.display_name}</p>
                        <p className="text-xs text-muted">{tr(`trustRole.${m.role}`)}</p>
                      </div>
                      <span className="text-xs font-bold" style={{ color: m.color ?? undefined }}>{pct}%</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-center text-xs">
                      <div><p className="font-bold">{steps.toLocaleString(locale)}</p><p className="text-muted">{tr('health.steps')}</p></div>
                      <div><p className="font-bold">{formatSleepHours(sleep)}</p><p className="text-muted">{tr('health.sleep')}</p></div>
                      <div><p className="font-bold">{hr > 0 ? `${hr.toLocaleString(locale)} ${tr('healthDashboard.unitBpm')}` : '--'}</p><p className="text-muted">{tr('health.heartRate')}</p></div>
                    </div>
                    <div className="mt-2.5 h-1.5 rounded-full bg-border">
                      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: m.color ?? undefined }} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Workouts + Insights */}
        <div className="grid gap-5 lg:grid-cols-2">
          {/* Recent Workouts */}
          <div className="rounded-2xl border border-border bg-surface/40 p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-semibold">{tr('health.recentWorkouts')}</h2>
              <button onClick={() => setWorkoutOpen(true)} className="text-xs font-semibold text-brand-text">{tr('health.logWorkout')}</button>
            </div>
            {workouts.length === 0 ? (
              <EmptyState icon={Dumbbell} title={tr('health.noWorkoutsLogged')} description={tr('healthModule.trackRunsSwimsBikeRides')} action={<Button onClick={() => setWorkoutOpen(true)} className="btn-cta"><Plus className="h-4 w-4" /> {tr('health.logWorkout')}</Button>} />
            ) : (
              <div className="space-y-3">
                {workouts.slice(0, 5).map((w) => {
                  const member = memberById.get(w.member_id);
                  return (
                    <div key={w.id} className="flex items-center gap-3">
                      <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-surface/40 text-xl">{workoutIcon(w.activity)}</div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold">{w.activity}</p>
                        <p className="text-xs text-muted">
                          {member?.display_name ?? tr('healthDashboard.unknownMember')}
                          {w.distance ? ` · ${w.distance.toLocaleString(locale)} ${tr('healthDashboard.unitMiles')}` : ''}
                          {w.duration_minutes ? ` · ${formatDuration(w.duration_minutes, locale, tr)}` : ''}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        {w.calories ? <p className="text-sm font-bold text-emerald-300">{w.calories.toLocaleString(locale)} {tr('healthDashboard.unitCalories')}</p> : null}
                        <p className="text-xs text-muted/60">{formatRelativeTime(w.recorded_at, locale, tr)}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Health Insights */}
          <div className="rounded-2xl border border-border bg-surface/40 p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-semibold">{tr('health.healthInsights')}</h2>
              <span className="flex items-center gap-1 text-xs text-brand-text"><Sparkles className="h-3 w-3" /> {tr('healthDashboard.dataDriven')}</span>
            </div>
            <div className="space-y-3">
              {insights.map((insight, i) => (
                <div key={i} className={cn('flex items-start gap-3 rounded-xl border p-3', insight.color)}>
                  <span className="text-lg shrink-0">{insight.icon}</span>
                  <p className="text-xs leading-5 text-fg">{insight.text}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Symptom Journal */}
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Thermometer className="h-4 w-4 text-rose-300" />
              <h2 className="font-semibold">{tr('health.symptomJournal')}</h2>
              {activeSymptomCount > 0 && (
                <span className="rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] font-bold text-rose-300">{tr('healthDashboard.activeCount', { count: activeSymptomCount.toLocaleString(locale) })}</span>
              )}
            </div>
            <Button onClick={() => setSymptomOpen(true)} className="btn-secondary"><Plus className="h-4 w-4" /> {tr('health.logSymptom')}</Button>
          </div>
          {sortedSymptoms.length === 0 ? (
            <EmptyState icon={Thermometer} title={tr('health.noSymptomsLogged')} description={tr('healthModule.trackIllnessesAndSymptomsOver')} action={<Button onClick={() => setSymptomOpen(true)} className="btn-cta"><Plus className="h-4 w-4" /> {tr('health.logSymptom')}</Button>} />
          ) : (
            <div className="space-y-2.5">
              {sortedSymptoms.slice(0, 12).map((s) => {
                const member = memberById.get(s.member_id);
                return (
                  <div key={s.id} className={cn('flex items-center gap-3 rounded-xl border border-border p-3', s.status === 'resolved' && 'opacity-60')}>
                    {member && <Avatar name={member.display_name} color={member.color} size={32} />}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-semibold">{s.symptom}</p>
                        <span className={cn('text-[10px] font-bold uppercase', SEVERITY_COLORS[s.severity] ?? 'text-muted')}>{SEVERITY_KEYS[s.severity] ? tr(SEVERITY_KEYS[s.severity]) : tr('healthDashboard.severityLevel', { level: s.severity.toLocaleString(locale) })}</span>
                        {s.status === 'resolved' && <span className="text-[10px] font-semibold text-emerald-300">{tr('health.resolved')}</span>}
                      </div>
                      <p className="truncate text-xs text-muted">
                        {member?.display_name ?? tr('healthDashboard.unknownMember')}
                        {s.body_area ? ` · ${s.body_area}` : ''}
                        {` · ${tr('healthDashboard.since', { time: formatRelativeTime(s.started_at, locale, tr) })}`}
                        {s.notes ? ` · ${s.notes}` : ''}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {s.status === 'active' && (
                        <button onClick={() => resolveSymptom(s)} title={tr('health.markResolved')} className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:text-emerald-300"><CheckCircle2 className="h-4 w-4" /></button>
                      )}
                      <button onClick={() => deleteSymptom(s)} title={tr('health.delete')} className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:text-rose-300"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── Sidebar ──────────────────────────────────────────── */}
      <aside className="module-sidebar hidden lg:flex lg:flex-col gap-5">
        {/* Health Summary */}
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <h2 className="mb-4 font-semibold">{tr('health.healthSummary')}</h2>
          <div className="space-y-4">
            {healthSummary.map(({ label, value, sub, color }) => (
              <div key={label} className="flex items-center justify-between">
                <div><p className="text-sm font-semibold">{label}</p><p className="text-xs text-muted">{sub}</p></div>
                <span className={cn('text-lg font-black', color)}>{value}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Upcoming Checkups */}
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold">{tr('health.upcomingCheckups')}</h2>
          </div>
          {appointments.length === 0 ? (
            <p className="text-sm text-muted text-center py-4">{tr('health.noUpcomingCheckups')}</p>
          ) : (
            <div className="space-y-3">
              {appointments.slice(0, 4).map((a, i) => {
                const d = new Date(a.starts_at);
                const member = a.member_id ? memberById.get(a.member_id) : undefined;
                return (
                  <div key={a.id} className="flex items-start gap-3">
                    <div className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-lg text-center text-fg', ACCENT[i % ACCENT.length])}>
                      <div>
                        <p className="text-[9px] font-bold uppercase">{d.toLocaleDateString(locale, { month: 'short' })}</p>
                        <p className="text-sm font-black leading-none">{d.getDate()}</p>
                      </div>
                    </div>
                    <div>
                      <p className="text-sm font-semibold">{a.title}</p>
                      {member && <p className="text-xs text-muted">{member.display_name}</p>}
                      {a.notes && <p className="text-xs text-muted/60">{a.notes}</p>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <button onClick={() => setApptOpen(true)} className="mt-4 flex w-full items-center justify-center gap-1.5 rounded-xl border border-border py-2.5 text-xs font-semibold text-muted hover:text-fg">
            <Plus className="h-3.5 w-3.5" /> {tr('health.addCheckup')}
          </button>
        </div>

        {/* Health Reminders */}
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold">{tr('health.healthReminders')}</h2>
          </div>
          {reminders.length === 0 ? (
            <p className="text-sm text-muted text-center py-4">{tr('health.noActiveReminders')}</p>
          ) : (
            <div className="space-y-3">
              {reminders.slice(0, 4).map((r) => (
                <div key={r.id} className="flex items-start gap-3">
                  <div className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 border-border" />
                  <div>
                    <p className="text-sm font-semibold">{r.title}</p>
                    {r.notes && <p className="text-xs text-muted">{r.notes}</p>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* AI Health Coach */}
        <div className="rounded-2xl border border-brand/25 bg-gradient-to-br from-violet-600/10 to-blue-900/10 p-5 text-center">
          <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-brand/15">
            <Sparkles className="h-6 w-6 text-brand-text" />
          </div>
          <h3 className="font-bold">{tr('health.aiHealthCoach')}</h3>
          <p className="mt-2 text-xs leading-5 text-muted">{tr('health.getPersonalizedHealthTipsAndWellness')}</p>
          <Button onClick={() => setCoachOpen(true)} className="btn-cta mt-4 w-full justify-center">{tr('health.askAi')}</Button>
        </div>
      </aside>

      {/* ── Modals ──────────────────────────────────────────── */}

      {/* Add Appointment Modal */}
      <Modal open={apptOpen} title={tr('health.addAppointment')} onClose={() => setApptOpen(false)}>
        <div className="space-y-4">
          <Field label={tr('health.title')}>{(id) => <Input id={id} value={apptForm.title} onChange={(e) => setApptForm((f) => ({ ...f, title: e.target.value }))} placeholder={tr('health.eGAnnualPhysical')} />}</Field>
          <Field label={tr('health.member')}>{(id) => <Select id={id} value={apptForm.member_id} onChange={(e) => setApptForm((f) => ({ ...f, member_id: e.target.value }))}><option value="">{tr('healthDashboard.allMembers')}</option>{members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</Select>}</Field>
          <Field label={tr('health.dateTime')}>{(id) => <Input id={id} type="datetime-local" value={apptForm.starts_at} onChange={(e) => setApptForm((f) => ({ ...f, starts_at: e.target.value }))} />}</Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={tr('health.provider')}>{(id) => <Input id={id} value={apptForm.provider} onChange={(e) => setApptForm((f) => ({ ...f, provider: e.target.value }))} placeholder={tr('health.eGDrMartinez')} />}</Field>
            <Field label={tr('health.location')}>{(id) => <Input id={id} value={apptForm.location} onChange={(e) => setApptForm((f) => ({ ...f, location: e.target.value }))} placeholder={tr('health.eGOakMedical')} />}</Field>
          </div>
          <Field label={tr('health.notes')}>{(id) => <Input id={id} value={apptForm.notes} onChange={(e) => setApptForm((f) => ({ ...f, notes: e.target.value }))} placeholder={tr('health.optionalDetails')} />}</Field>
          <Button onClick={saveAppointment} disabled={saving || !apptForm.title || !apptForm.starts_at} loading={saving} className="w-full">{saving ? tr('healthDashboard.saving') : tr('health.addAppointment')}</Button>
        </div>
      </Modal>

      {/* Log Metric Modal */}
      <Modal open={metricOpen} title={tr('health.logHealthMetric')} onClose={() => setMetricOpen(false)}>
        <div className="space-y-4">
          <Field label={tr('health.familyMember')}>{(id) => <Select id={id} value={metricForm.member_id} onChange={(e) => setMetricForm((f) => ({ ...f, member_id: e.target.value }))}><option value="">{tr('health.selectMember')}</option>{members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</Select>}</Field>
          <Field label={tr('health.metricType')}>{(id) => <Select id={id} value={metricForm.type} onChange={(e) => setMetricForm((f) => ({ ...f, type: e.target.value as MetricType }))}>{METRIC_TYPES.map((t) => <option key={t.value} value={t.value}>{tr(t.labelKey)} ({tr(t.unitKey)})</option>)}</Select>}</Field>
          <Field label={tr('health.value')}>{(id) => <Input id={id} type="number" value={metricForm.value} onChange={(e) => setMetricForm((f) => ({ ...f, value: e.target.value }))} placeholder={tr('healthDashboard.numberExample', { value: metricForm.type === 'steps' ? '10000' : metricForm.type === 'sleep_hours' ? '7.5' : '72' })} />}</Field>
          <Field label={tr('health.dateTimeOptional')}>{(id) => <Input id={id} type="datetime-local" value={metricForm.recorded_at} onChange={(e) => setMetricForm((f) => ({ ...f, recorded_at: e.target.value }))} />}</Field>
          <Button onClick={saveMetric} disabled={saving || !metricForm.member_id || !metricForm.value} loading={saving} className="w-full">{saving ? tr('healthDashboard.saving') : tr('health.logMetric')}</Button>
        </div>
      </Modal>

      {/* Log Workout Modal */}
      <Modal open={workoutOpen} title={tr('health.logWorkout')} onClose={() => setWorkoutOpen(false)}>
        <div className="space-y-4">
          <Field label={tr('health.familyMember')}>{(id) => <Select id={id} value={workoutForm.member_id} onChange={(e) => setWorkoutForm((f) => ({ ...f, member_id: e.target.value }))}><option value="">{tr('health.selectMember')}</option>{members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</Select>}</Field>
          <Field label={tr('health.activity')}>{(id) => <Input id={id} value={workoutForm.activity} onChange={(e) => setWorkoutForm((f) => ({ ...f, activity: e.target.value }))} placeholder={tr('health.eGMorningRunSwimPractice')} />}</Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={tr('health.durationMin')}>{(id) => <Input id={id} type="number" value={workoutForm.duration_minutes} onChange={(e) => setWorkoutForm((f) => ({ ...f, duration_minutes: e.target.value }))} placeholder={tr('health.eG30')} />}</Field>
            <Field label={tr('health.calories')}>{(id) => <Input id={id} type="number" value={workoutForm.calories} onChange={(e) => setWorkoutForm((f) => ({ ...f, calories: e.target.value }))} placeholder={tr('health.eG285')} />}</Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label={tr('health.distanceMiles')}>{(id) => <Input id={id} type="number" inputMode="decimal" step="0.1" value={workoutForm.distance} onChange={(e) => setWorkoutForm((f) => ({ ...f, distance: e.target.value }))} placeholder={tr('health.eG32')} />}</Field>
            <Field label={tr('health.dateTime')}>{(id) => <Input id={id} type="datetime-local" value={workoutForm.recorded_at} onChange={(e) => setWorkoutForm((f) => ({ ...f, recorded_at: e.target.value }))} />}</Field>
          </div>
          <Field label={tr('health.notesOptional')}>{(id) => <Input id={id} value={workoutForm.notes} onChange={(e) => setWorkoutForm((f) => ({ ...f, notes: e.target.value }))} placeholder={tr('health.eGFeltGreatPrPace')} />}</Field>
          <Button onClick={saveWorkout} disabled={saving || !workoutForm.member_id || !workoutForm.activity} loading={saving} className="w-full">{saving ? tr('healthDashboard.saving') : tr('health.logWorkout')}</Button>
        </div>
      </Modal>

      {/* Log Symptom Modal */}
      <Modal open={symptomOpen} title={tr('health.logSymptom')} onClose={() => setSymptomOpen(false)}>
        <div className="space-y-4">
          <Field label={tr('health.familyMember')}>{(id) => <Select id={id} value={symptomForm.member_id} onChange={(e) => setSymptomForm((f) => ({ ...f, member_id: e.target.value }))}><option value="">{tr('health.selectMember')}</option>{members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</Select>}</Field>
          <Field label={tr('health.symptom')}>{(id) => <Input id={id} value={symptomForm.symptom} onChange={(e) => setSymptomForm((f) => ({ ...f, symptom: e.target.value }))} placeholder={tr('health.eGHeadacheSoreThroatFever')} />}</Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={tr('health.severity')}>{(id) => <Select id={id} value={symptomForm.severity} onChange={(e) => setSymptomForm((f) => ({ ...f, severity: e.target.value }))}><option value="1">{tr('health.1Mild')}</option><option value="2">{tr('health.2Mild')}</option><option value="3">{tr('health.3Moderate')}</option><option value="4">{tr('health.4Severe')}</option><option value="5">{tr('health.5Severe')}</option></Select>}</Field>
            <Field label={tr('health.bodyAreaOptional')}>{(id) => <Input id={id} value={symptomForm.body_area} onChange={(e) => setSymptomForm((f) => ({ ...f, body_area: e.target.value }))} placeholder={tr('health.eGHeadStomach')} />}</Field>
          </div>
          <Field label={tr('health.startedOptional')}>{(id) => <Input id={id} type="datetime-local" value={symptomForm.started_at} onChange={(e) => setSymptomForm((f) => ({ ...f, started_at: e.target.value }))} />}</Field>
          <Field label={tr('health.notesOptional')}>{(id) => <Textarea id={id} value={symptomForm.notes} onChange={(e) => setSymptomForm((f) => ({ ...f, notes: e.target.value }))} placeholder={tr('health.eGStartedAfterLunchTook')} />}</Field>
          <Button onClick={saveSymptom} disabled={saving || !symptomForm.member_id || !symptomForm.symptom.trim()} loading={saving} className="w-full">{saving ? tr('healthDashboard.saving') : tr('health.logSymptom')}</Button>
        </div>
      </Modal>

      {/* Set Goal Modal */}
      <Modal open={goalOpen} title={tr('health.setHealthGoal')} onClose={() => setGoalOpen(false)}>
        <div className="space-y-4">
          <p className="text-xs text-muted">{tr('healthModule.setAPerMemberDaily')}</p>
          <Field label={tr('health.familyMember')}>{(id) => <Select id={id} value={goalForm.member_id} onChange={(e) => setGoalForm((f) => ({ ...f, member_id: e.target.value }))}><option value="">{tr('health.selectMember')}</option>{members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</Select>}</Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={tr('health.metric')}>{(id) => <Select id={id} value={goalForm.metric_type} onChange={(e) => setGoalForm((f) => ({ ...f, metric_type: e.target.value as MetricType }))}>{METRIC_TYPES.map((t) => <option key={t.value} value={t.value}>{tr(t.labelKey)}</option>)}</Select>}</Field>
            <Field label={tr('health.period')}>{(id) => <Select id={id} value={goalForm.period} onChange={(e) => setGoalForm((f) => ({ ...f, period: e.target.value as 'daily' | 'weekly' }))}><option value="daily">{tr('health.daily')}</option><option value="weekly">{tr('health.weekly')}</option></Select>}</Field>
          </div>
          <Field label={tr('health.target')}>{(id) => <Input id={id} type="number" value={goalForm.target} onChange={(e) => setGoalForm((f) => ({ ...f, target: e.target.value }))} placeholder={tr('healthDashboard.numberExample', { value: goalForm.metric_type === 'steps' ? '10000' : goalForm.metric_type === 'sleep_hours' ? '8' : '60' })} />}</Field>
          <Button onClick={saveGoal} disabled={saving || !goalForm.member_id || !goalForm.target} loading={saving} className="w-full">{saving ? tr('healthDashboard.saving') : tr('healthDashboard.saveGoal')}</Button>
        </div>
      </Modal>

      {/* AI Health Coach Modal */}
      <Modal open={coachOpen} title={tr('health.aiHealthCoach')} onClose={() => setCoachOpen(false)}>
        <div className="space-y-4">
          <p className="text-xs leading-5 text-muted">{tr('healthDashboard.coachDescription')}</p>
          <Field label={tr('health.aboutOptional')}>{(id) => <Select id={id} value={coachForm.member_id} onChange={(e) => setCoachForm((f) => ({ ...f, member_id: e.target.value }))}><option value="">{tr('health.generalWholeFamily')}</option>{members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</Select>}</Field>
          <Field label={tr('health.question')}>{(id) => <Textarea id={id} value={coachForm.question} onChange={(e) => setCoachForm((f) => ({ ...f, question: e.target.value }))} placeholder={tr('health.eGWhatCanHelpWith')} />}</Field>
          <Button onClick={askCoach} disabled={coachLoading || !coachForm.question.trim()} loading={coachLoading} className="w-full">
            {coachLoading ? <><Loader2 className="h-4 w-4 animate-spin" /> {tr('healthDashboard.thinking')}</> : <><Sparkles className="h-4 w-4" /> {tr('health.askTheCoach')}</>}
          </Button>
          {coachError && <p className="rounded-xl border border-danger/30 bg-danger/10 p-3 text-xs text-danger">{coachError}</p>}
          {coachAnswer && (
            <div className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-xl border border-border bg-surface/40 p-4 text-sm leading-6 text-fg">{coachAnswer}</div>
          )}
        </div>
      </Modal>
    </div>
  );
}
