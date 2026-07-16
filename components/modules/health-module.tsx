'use client';

import { useMemo, useState } from 'react';
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

type HealthMetric = Tables<'health_metrics'>;
type WorkoutLog = Tables<'workout_logs'>;
type Appointment = Tables<'appointments'>;
type Reminder = Tables<'reminders'>;
type SymptomLog = Tables<'symptom_logs'>;
type HealthGoal = Tables<'health_goals'>;

const SEVERITY_LABELS = ['', 'Mild', 'Mild', 'Moderate', 'Severe', 'Severe'];
const SEVERITY_COLORS = ['', 'text-emerald-300', 'text-emerald-300', 'text-amber-300', 'text-orange-300', 'text-rose-300'];

const TABS = ['Overview', 'Activity', 'Nutrition', 'Sleep', 'Checkups', 'Medications', 'Documents', 'Vitals'] as const;
type Tab = (typeof TABS)[number];

const METRIC_TYPES: { value: MetricType; label: string; unit: string }[] = [
  { value: 'steps', label: 'Steps', unit: 'steps' },
  { value: 'sleep_hours', label: 'Sleep', unit: 'hours' },
  { value: 'heart_rate', label: 'Heart Rate', unit: 'bpm' },
  { value: 'calories', label: 'Calories', unit: 'kcal' },
  { value: 'active_minutes', label: 'Active Minutes', unit: 'min' },
  { value: 'distance', label: 'Distance', unit: 'miles' },
  { value: 'weight', label: 'Weight', unit: 'lbs' },
  { value: 'water_cups', label: 'Water', unit: 'cups' },
];

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

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

function formatDuration(mins: number | null) {
  if (!mins) return '0 min';
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatRelativeTime(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / 86400000);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (diffDays === 0) return `Today ${time}`;
  if (diffDays === 1) return `Yesterday ${time}`;
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${time}`;
}

const WORKOUT_ICONS: Record<string, string> = {
  run: 'ðŸƒ', running: 'ðŸƒ', jog: 'ðŸƒ',
  swim: 'ðŸŠ', swimming: 'ðŸŠ',
  bike: 'ðŸš´', cycling: 'ðŸš´', biking: 'ðŸš´',
  walk: 'ðŸš¶', walking: 'ðŸš¶', hike: 'ðŸš¶', hiking: 'ðŸ¥¾',
  yoga: 'ðŸ§˜', pilates: 'ðŸ§˜',
  weights: 'ðŸ‹ï¸', lifting: 'ðŸ‹ï¸', gym: 'ðŸ‹ï¸', strength: 'ðŸ‹ï¸',
  dance: 'ðŸ’ƒ', basketball: 'ðŸ€', soccer: 'âš½', tennis: 'ðŸŽ¾', golf: 'â›³',
};

function workoutIcon(activity: string) {
  const lower = activity.toLowerCase();
  for (const [key, icon] of Object.entries(WORKOUT_ICONS)) {
    if (lower.includes(key)) return icon;
  }
  return 'ðŸ…';
}

export function HealthModule() {
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

  // â”€â”€ Data queries â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  // â”€â”€ Derived data â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const todayMetrics = useMemo(() => metrics.filter((m) => m.recorded_at >= todayISO), [metrics, todayISO]);

  const totalStepsToday = useMemo(() => todayMetrics.filter((m) => m.type === 'steps').reduce((s, m) => s + m.value, 0), [todayMetrics]);
  const totalCaloriesToday = useMemo(() => todayMetrics.filter((m) => m.type === 'calories').reduce((s, m) => s + m.value, 0), [todayMetrics]);
  const avgSleepToday = useMemo(() => {
    const sleeps = todayMetrics.filter((m) => m.type === 'sleep_hours');
    if (sleeps.length === 0) return 0;
    return sleeps.reduce((s, m) => s + m.value, 0) / sleeps.length;
  }, [todayMetrics]);
  const totalActiveMinToday = useMemo(() => todayMetrics.filter((m) => m.type === 'active_minutes').reduce((s, m) => s + m.value, 0), [todayMetrics]);

  const formatSleepHours = (h: number) => {
    if (h === 0) return '0h';
    const hrs = Math.floor(h);
    const mins = Math.round((h - hrs) * 60);
    return mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`;
  };

  // Stats grid
  const statsGrid = useMemo(() => [
    { icon: Heart, label: 'Family Members', value: members.length, sub: 'Tracking health', bg: 'bg-rose-600/20 text-rose-300' },
    { icon: Activity, label: 'Steps Today', value: totalStepsToday.toLocaleString(), sub: 'Family combined', bg: 'bg-brand/15 text-brand-text' },
    { icon: Zap, label: 'Active Calories', value: totalCaloriesToday.toLocaleString(), sub: 'Today combined', bg: 'bg-orange-600/20 text-orange-300' },
    { icon: Activity, label: 'Avg Sleep', value: formatSleepHours(avgSleepToday), sub: 'Last night', bg: 'bg-blue-600/20 text-blue-300' },
  ], [members.length, totalStepsToday, totalCaloriesToday, avgSleepToday]);

  // Activity summary progress bars
  const activityProgress = useMemo(() => [
    { label: 'Steps', val: totalStepsToday.toLocaleString(), goal: familyStepsGoal.toLocaleString(), pct: Math.min(100, Math.round((totalStepsToday / familyStepsGoal) * 100)) },
    { label: 'Calories', val: totalCaloriesToday.toLocaleString(), goal: '2,000', pct: Math.min(100, Math.round((totalCaloriesToday / 2000) * 100)) },
    { label: 'Active Min', val: totalActiveMinToday.toString(), goal: '60', pct: Math.min(100, Math.round((totalActiveMinToday / 60) * 100)) },
  ], [totalStepsToday, totalCaloriesToday, totalActiveMinToday, familyStepsGoal]);

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
      days.push({ day: DAY_NAMES[d.getDay()], val: daySteps });
    }
    const max = Math.max(...days.map((d) => d.val), 1);
    return days.map((d) => ({ ...d, pct: Math.round((d.val / max) * 100) }));
  }, [metrics]);

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
      { label: 'Avg Steps', value: avgSteps.toLocaleString(), sub: 'Family average', color: 'text-brand-text' },
      { label: 'Avg Sleep', value: formatSleepHours(avgSleep), sub: 'Per night', color: 'text-blue-300' },
      { label: 'Calories Burned', value: totalCals.toLocaleString(), sub: 'This week total', color: 'text-emerald-300' },
      { label: 'Active Days', value: `${activeDaySet.size} / 7`, sub: 'This week', color: 'text-orange-300' },
    ];
  }, [metrics]);

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
          icon: 'ðŸ’¡',
          text: `${m.display_name} has hit their step goal for ${consecutive} days in a row!`,
          color: 'bg-violet-500/15 border-violet-400/20',
        });
      }
    }

    // Sleep improvement check
    const thisWeekSleep = metrics.filter((m) => m.type === 'sleep_hours' && m.recorded_at >= daysAgo(7));
    const avgThisWeek = thisWeekSleep.length > 0 ? thisWeekSleep.reduce((s, m) => s + m.value, 0) / thisWeekSleep.length : 0;
    if (avgThisWeek >= 8) {
      result.push({
        icon: 'ðŸ˜´',
        text: `Family is averaging ${formatSleepHours(avgThisWeek)} of sleep this week. Great rest!`,
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
          icon: 'âš ï¸',
          text: `${member ? member.display_name + ' has' : 'There is'} a checkup in ${daysUntil} day${daysUntil === 1 ? '' : 's'}: ${next.title}`,
          color: 'bg-orange-500/15 border-orange-400/20',
        });
      }
    }

    // Hydration check
    const todayWater = todayMetrics.filter((m) => m.type === 'water_cups').reduce((s, m) => s + m.value, 0);
    if (todayWater > 0 && todayWater < 8) {
      result.push({
        icon: 'ðŸ’§',
        text: `Family has logged ${todayWater} cups of water today. Keep hydrating!`,
        color: 'bg-cyan-500/15 border-cyan-400/20',
      });
    }

    if (result.length === 0) {
      result.push({
        icon: 'ðŸ“Š',
        text: 'Start logging health metrics to see personalized insights for your family.',
        color: 'bg-violet-500/15 border-violet-400/20',
      });
    }

    return result;
  }, [metrics, todayMetrics, members, appointments, memberById, stepGoalFor]);

  // â”€â”€ CRUD handlers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    if (err) { toastError('Failed to save appointment'); return; }
    success('Appointment added!');
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
    if (err) { toastError('Failed to log metric'); return; }
    success('Metric logged!');
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
    if (err) { toastError('Failed to log workout'); return; }
    success('Workout logged!');
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
    if (err) { toastError('Failed to log symptom'); return; }
    success('Symptom logged!');
    setSymptomOpen(false);
    setSymptomForm({ member_id: '', symptom: '', severity: '3', body_area: '', notes: '', started_at: '' });
  }

  async function resolveSymptom(s: SymptomLog) {
    const sb = createClient();
    const { error: err } = await sb.from('symptom_logs').update({ status: 'resolved', ended_at: new Date().toISOString() }).eq('id', s.id);
    if (err) { toastError('Failed to update symptom'); return; }
    success('Marked resolved.');
  }

  async function deleteSymptom(s: SymptomLog) {
    const sb = createClient();
    const { error: err } = await sb.from('symptom_logs').delete().eq('id', s.id);
    if (err) { toastError('Failed to delete symptom'); return; }
    success('Symptom removed.');
  }

  async function saveGoal() {
    if (!goalForm.member_id || !goalForm.target) return;
    const target = parseFloat(goalForm.target);
    if (!(target > 0)) { toastError('Target must be greater than 0.'); return; }
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
    if (err) { toastError('Failed to save goal'); return; }
    success('Goal saved!');
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
      if (!res.ok) { setCoachError(json.error || 'The coach is unavailable right now.'); return; }
      setCoachAnswer(json.text || '');
    } catch {
      setCoachError('Network error. Please try again.');
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

  // â”€â”€ Loading / Error â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (loading) return <SkeletonList />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  const ACCENT = ['bg-violet-500', 'bg-blue-500', 'bg-emerald-500', 'bg-orange-500'];

  return (
    <div className="module-with-sidebar">
      <div className="module-main space-y-5">
        <PageHeader
          title="Health"
          description="Track fitness, wellness, and health across your whole family."
          action={
            <div className="flex gap-2">
              <Button onClick={() => setMetricOpen(true)} className="btn-cta"><Plus className="h-4 w-4" /> Log Metric</Button>
              <Button onClick={() => setWorkoutOpen(true)} className="btn-secondary"><Dumbbell className="h-4 w-4" /> Log Workout</Button>
            </div>
          }
        />

        {/* Tab bar */}
        <div className="flex items-center justify-between border-b border-border">
          <div className="tab-bar">
            {TABS.map((t) => (
              <button key={t} onClick={() => setTab(t)} className={cn('tab-item', tab === t ? 'tab-item-active' : 'tab-item-inactive')}>{t}</button>
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
              <h2 className="font-semibold">Activity Summary</h2>
              <button onClick={() => setGoalOpen(true)} className="flex items-center gap-1 text-xs font-semibold text-brand-text"><Target className="h-3 w-3" /> Set goals</button>
            </div>
            {metrics.length === 0 ? (
              <EmptyState icon={Activity} title="No activity data yet" description="Log your first health metric to see activity summaries." action={<Button onClick={() => setMetricOpen(true)} className="btn-cta"><Plus className="h-4 w-4" /> Log Metric</Button>} />
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
                      <span className="text-[10px] text-muted">Goal Met</span>
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
                  <p className="mb-3 text-xs text-muted">This Week</p>
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
              <h2 className="font-semibold">Family Health at a Glance</h2>
            </div>
            {memberStats.every((ms) => ms.steps === 0 && ms.sleep === 0 && ms.hr === 0) ? (
              <EmptyState icon={Heart} title="No member health data" description="Log metrics for family members to see their health at a glance." action={<Button onClick={() => setMetricOpen(true)} className="btn-cta"><Plus className="h-4 w-4" /> Log Metric</Button>} />
            ) : (
              <div className="max-h-[32rem] space-y-3 overflow-y-auto">
                {memberStats.map(({ member: m, steps, sleep, hr, pct }) => (
                  <div key={m.id} className="rounded-xl border border-border p-3">
                    <div className="flex items-center gap-3 mb-2.5">
                      <Avatar name={m.display_name} color={m.color} size={32} />
                      <div className="flex-1">
                        <p className="text-sm font-semibold">{m.display_name}</p>
                        <p className="text-xs text-muted">{m.role}</p>
                      </div>
                      <span className="text-xs font-bold" style={{ color: m.color ?? undefined }}>{pct}%</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-center text-xs">
                      <div><p className="font-bold">{steps.toLocaleString()}</p><p className="text-muted">Steps</p></div>
                      <div><p className="font-bold">{formatSleepHours(sleep)}</p><p className="text-muted">Sleep</p></div>
                      <div><p className="font-bold">{hr > 0 ? `${hr} bpm` : '--'}</p><p className="text-muted">Heart Rate</p></div>
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
              <h2 className="font-semibold">Recent Workouts</h2>
              <button onClick={() => setWorkoutOpen(true)} className="text-xs font-semibold text-brand-text">+ Log workout</button>
            </div>
            {workouts.length === 0 ? (
              <EmptyState icon={Dumbbell} title="No workouts logged" description="Track runs, swims, bike rides, and more." action={<Button onClick={() => setWorkoutOpen(true)} className="btn-cta"><Plus className="h-4 w-4" /> Log Workout</Button>} />
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
                          {member?.display_name ?? 'Unknown'}
                          {w.distance ? ` Â· ${w.distance} mi` : ''}
                          {w.duration_minutes ? ` Â· ${formatDuration(w.duration_minutes)}` : ''}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        {w.calories ? <p className="text-sm font-bold text-emerald-300">{w.calories} cal</p> : null}
                        <p className="text-xs text-muted/60">{formatRelativeTime(w.recorded_at)}</p>
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
              <h2 className="font-semibold">Health Insights</h2>
              <span className="flex items-center gap-1 text-xs text-brand-text"><Sparkles className="h-3 w-3" /> Data-driven</span>
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
              <h2 className="font-semibold">Symptom Journal</h2>
              {activeSymptomCount > 0 && (
                <span className="rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] font-bold text-rose-300">{activeSymptomCount} active</span>
              )}
            </div>
            <Button onClick={() => setSymptomOpen(true)} className="btn-secondary"><Plus className="h-4 w-4" /> Log symptom</Button>
          </div>
          {sortedSymptoms.length === 0 ? (
            <EmptyState icon={Thermometer} title="No symptoms logged" description="Track illnesses and symptoms over time â€” severity, body area, and when they started." action={<Button onClick={() => setSymptomOpen(true)} className="btn-cta"><Plus className="h-4 w-4" /> Log symptom</Button>} />
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
                        <span className={cn('text-[10px] font-bold uppercase', SEVERITY_COLORS[s.severity] ?? 'text-muted')}>{SEVERITY_LABELS[s.severity] ?? `Lvl ${s.severity}`}</span>
                        {s.status === 'resolved' && <span className="text-[10px] font-semibold text-emerald-300">Resolved</span>}
                      </div>
                      <p className="truncate text-xs text-muted">
                        {member?.display_name ?? 'Unknown'}
                        {s.body_area ? ` Â· ${s.body_area}` : ''}
                        {` Â· since ${formatRelativeTime(s.started_at)}`}
                        {s.notes ? ` Â· ${s.notes}` : ''}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {s.status === 'active' && (
                        <button onClick={() => resolveSymptom(s)} title="Mark resolved" className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:text-emerald-300"><CheckCircle2 className="h-4 w-4" /></button>
                      )}
                      <button onClick={() => deleteSymptom(s)} title="Delete" className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:text-rose-300"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* â”€â”€ Sidebar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <aside className="module-sidebar hidden lg:flex lg:flex-col gap-5">
        {/* Health Summary */}
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <h2 className="mb-4 font-semibold">Health Summary</h2>
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
            <h2 className="font-semibold">Upcoming Checkups</h2>
          </div>
          {appointments.length === 0 ? (
            <p className="text-sm text-muted text-center py-4">No upcoming checkups.</p>
          ) : (
            <div className="space-y-3">
              {appointments.slice(0, 4).map((a, i) => {
                const d = new Date(a.starts_at);
                const member = a.member_id ? memberById.get(a.member_id) : undefined;
                return (
                  <div key={a.id} className="flex items-start gap-3">
                    <div className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-lg text-center text-fg', ACCENT[i % ACCENT.length])}>
                      <div>
                        <p className="text-[9px] font-bold uppercase">{d.toLocaleDateString('en-US', { month: 'short' })}</p>
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
            <Plus className="h-3.5 w-3.5" /> Add Checkup
          </button>
        </div>

        {/* Health Reminders */}
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold">Health Reminders</h2>
          </div>
          {reminders.length === 0 ? (
            <p className="text-sm text-muted text-center py-4">No active reminders.</p>
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
          <h3 className="font-bold">AI Health Coach</h3>
          <p className="mt-2 text-xs leading-5 text-muted">Get personalized health tips and wellness insights for your family.</p>
          <Button onClick={() => setCoachOpen(true)} className="btn-cta mt-4 w-full justify-center">Ask AI</Button>
        </div>
      </aside>

      {/* â”€â”€ Modals â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}

      {/* Add Appointment Modal */}
      <Modal open={apptOpen} title="Add Appointment" onClose={() => setApptOpen(false)}>
        <div className="space-y-4">
          <Field label="Title">{(id) => <Input id={id} value={apptForm.title} onChange={(e) => setApptForm((f) => ({ ...f, title: e.target.value }))} placeholder="e.g. Annual Physical" />}</Field>
          <Field label="Member">{(id) => <Select id={id} value={apptForm.member_id} onChange={(e) => setApptForm((f) => ({ ...f, member_id: e.target.value }))}><option value="">All</option>{members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</Select>}</Field>
          <Field label="Date & Time">{(id) => <Input id={id} type="datetime-local" value={apptForm.starts_at} onChange={(e) => setApptForm((f) => ({ ...f, starts_at: e.target.value }))} />}</Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Provider">{(id) => <Input id={id} value={apptForm.provider} onChange={(e) => setApptForm((f) => ({ ...f, provider: e.target.value }))} placeholder="e.g. Dr. Martinez" />}</Field>
            <Field label="Location">{(id) => <Input id={id} value={apptForm.location} onChange={(e) => setApptForm((f) => ({ ...f, location: e.target.value }))} placeholder="e.g. Oak Medical" />}</Field>
          </div>
          <Field label="Notes">{(id) => <Input id={id} value={apptForm.notes} onChange={(e) => setApptForm((f) => ({ ...f, notes: e.target.value }))} placeholder="Optional details" />}</Field>
          <Button onClick={saveAppointment} disabled={saving || !apptForm.title || !apptForm.starts_at} loading={saving} className="w-full">{saving ? 'Saving...' : 'Add Appointment'}</Button>
        </div>
      </Modal>

      {/* Log Metric Modal */}
      <Modal open={metricOpen} title="Log Health Metric" onClose={() => setMetricOpen(false)}>
        <div className="space-y-4">
          <Field label="Family Member">{(id) => <Select id={id} value={metricForm.member_id} onChange={(e) => setMetricForm((f) => ({ ...f, member_id: e.target.value }))}><option value="">Select member</option>{members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</Select>}</Field>
          <Field label="Metric Type">{(id) => <Select id={id} value={metricForm.type} onChange={(e) => setMetricForm((f) => ({ ...f, type: e.target.value as MetricType }))}>{METRIC_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label} ({t.unit})</option>)}</Select>}</Field>
          <Field label="Value">{(id) => <Input id={id} type="number" value={metricForm.value} onChange={(e) => setMetricForm((f) => ({ ...f, value: e.target.value }))} placeholder={`e.g. ${metricForm.type === 'steps' ? '10000' : metricForm.type === 'sleep_hours' ? '7.5' : '72'}`} />}</Field>
          <Field label="Date & Time (optional)">{(id) => <Input id={id} type="datetime-local" value={metricForm.recorded_at} onChange={(e) => setMetricForm((f) => ({ ...f, recorded_at: e.target.value }))} />}</Field>
          <Button onClick={saveMetric} disabled={saving || !metricForm.member_id || !metricForm.value} loading={saving} className="w-full">{saving ? 'Saving...' : 'Log Metric'}</Button>
        </div>
      </Modal>

      {/* Log Workout Modal */}
      <Modal open={workoutOpen} title="Log Workout" onClose={() => setWorkoutOpen(false)}>
        <div className="space-y-4">
          <Field label="Family Member">{(id) => <Select id={id} value={workoutForm.member_id} onChange={(e) => setWorkoutForm((f) => ({ ...f, member_id: e.target.value }))}><option value="">Select member</option>{members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</Select>}</Field>
          <Field label="Activity">{(id) => <Input id={id} value={workoutForm.activity} onChange={(e) => setWorkoutForm((f) => ({ ...f, activity: e.target.value }))} placeholder="e.g. Morning Run, Swim Practice" />}</Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Duration (min)">{(id) => <Input id={id} type="number" value={workoutForm.duration_minutes} onChange={(e) => setWorkoutForm((f) => ({ ...f, duration_minutes: e.target.value }))} placeholder="e.g. 30" />}</Field>
            <Field label="Calories">{(id) => <Input id={id} type="number" value={workoutForm.calories} onChange={(e) => setWorkoutForm((f) => ({ ...f, calories: e.target.value }))} placeholder="e.g. 285" />}</Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Distance (miles)">{(id) => <Input id={id} type="number" step="0.1" value={workoutForm.distance} onChange={(e) => setWorkoutForm((f) => ({ ...f, distance: e.target.value }))} placeholder="e.g. 3.2" />}</Field>
            <Field label="Date & Time">{(id) => <Input id={id} type="datetime-local" value={workoutForm.recorded_at} onChange={(e) => setWorkoutForm((f) => ({ ...f, recorded_at: e.target.value }))} />}</Field>
          </div>
          <Field label="Notes (optional)">{(id) => <Input id={id} value={workoutForm.notes} onChange={(e) => setWorkoutForm((f) => ({ ...f, notes: e.target.value }))} placeholder="e.g. Felt great, PR pace" />}</Field>
          <Button onClick={saveWorkout} disabled={saving || !workoutForm.member_id || !workoutForm.activity} loading={saving} className="w-full">{saving ? 'Saving...' : 'Log Workout'}</Button>
        </div>
      </Modal>

      {/* Log Symptom Modal */}
      <Modal open={symptomOpen} title="Log Symptom" onClose={() => setSymptomOpen(false)}>
        <div className="space-y-4">
          <Field label="Family Member">{(id) => <Select id={id} value={symptomForm.member_id} onChange={(e) => setSymptomForm((f) => ({ ...f, member_id: e.target.value }))}><option value="">Select member</option>{members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</Select>}</Field>
          <Field label="Symptom">{(id) => <Input id={id} value={symptomForm.symptom} onChange={(e) => setSymptomForm((f) => ({ ...f, symptom: e.target.value }))} placeholder="e.g. Headache, Sore throat, Fever" />}</Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Severity">{(id) => <Select id={id} value={symptomForm.severity} onChange={(e) => setSymptomForm((f) => ({ ...f, severity: e.target.value }))}><option value="1">1 â€” Mild</option><option value="2">2 â€” Mild</option><option value="3">3 â€” Moderate</option><option value="4">4 â€” Severe</option><option value="5">5 â€” Severe</option></Select>}</Field>
            <Field label="Body Area (optional)">{(id) => <Input id={id} value={symptomForm.body_area} onChange={(e) => setSymptomForm((f) => ({ ...f, body_area: e.target.value }))} placeholder="e.g. Head, Stomach" />}</Field>
          </div>
          <Field label="Started (optional)">{(id) => <Input id={id} type="datetime-local" value={symptomForm.started_at} onChange={(e) => setSymptomForm((f) => ({ ...f, started_at: e.target.value }))} />}</Field>
          <Field label="Notes (optional)">{(id) => <Textarea id={id} value={symptomForm.notes} onChange={(e) => setSymptomForm((f) => ({ ...f, notes: e.target.value }))} placeholder="e.g. Started after lunch, took ibuprofen" />}</Field>
          <Button onClick={saveSymptom} disabled={saving || !symptomForm.member_id || !symptomForm.symptom.trim()} loading={saving} className="w-full">{saving ? 'Saving...' : 'Log Symptom'}</Button>
        </div>
      </Modal>

      {/* Set Goal Modal */}
      <Modal open={goalOpen} title="Set Health Goal" onClose={() => setGoalOpen(false)}>
        <div className="space-y-4">
          <p className="text-xs text-muted">Set a per-member daily or weekly target. Progress rings and insights use these goals (steps default to 10,000 when no goal is set).</p>
          <Field label="Family Member">{(id) => <Select id={id} value={goalForm.member_id} onChange={(e) => setGoalForm((f) => ({ ...f, member_id: e.target.value }))}><option value="">Select member</option>{members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</Select>}</Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Metric">{(id) => <Select id={id} value={goalForm.metric_type} onChange={(e) => setGoalForm((f) => ({ ...f, metric_type: e.target.value as MetricType }))}>{METRIC_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</Select>}</Field>
            <Field label="Period">{(id) => <Select id={id} value={goalForm.period} onChange={(e) => setGoalForm((f) => ({ ...f, period: e.target.value as 'daily' | 'weekly' }))}><option value="daily">Daily</option><option value="weekly">Weekly</option></Select>}</Field>
          </div>
          <Field label="Target">{(id) => <Input id={id} type="number" value={goalForm.target} onChange={(e) => setGoalForm((f) => ({ ...f, target: e.target.value }))} placeholder={`e.g. ${goalForm.metric_type === 'steps' ? '10000' : goalForm.metric_type === 'sleep_hours' ? '8' : '60'}`} />}</Field>
          <Button onClick={saveGoal} disabled={saving || !goalForm.member_id || !goalForm.target} loading={saving} className="w-full">{saving ? 'Saving...' : 'Save Goal'}</Button>
        </div>
      </Modal>

      {/* AI Health Coach Modal */}
      <Modal open={coachOpen} title="AI Health Coach" onClose={() => setCoachOpen(false)}>
        <div className="space-y-4">
          <p className="text-xs leading-5 text-muted">Ask a wellness question. The coach uses your family&rsquo;s own health data (profile, active meds, recent symptoms) to give grounded, safety-first guidance. This is general wellness information, not medical advice.</p>
          <Field label="About (optional)">{(id) => <Select id={id} value={coachForm.member_id} onChange={(e) => setCoachForm((f) => ({ ...f, member_id: e.target.value }))}><option value="">General / whole family</option>{members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</Select>}</Field>
          <Field label="Question">{(id) => <Textarea id={id} value={coachForm.question} onChange={(e) => setCoachForm((f) => ({ ...f, question: e.target.value }))} placeholder="e.g. What can help with a lingering cough and when should we see a doctor?" />}</Field>
          <Button onClick={askCoach} disabled={coachLoading || !coachForm.question.trim()} loading={coachLoading} className="w-full">
            {coachLoading ? <><Loader2 className="h-4 w-4 animate-spin" /> Thinking...</> : <><Sparkles className="h-4 w-4" /> Ask the Coach</>}
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
