'use server';

// Autonomous prep-plan generation — the wired "prepare, don't notify" loop. Reads
// the family's real upcoming signals (trips, member birthdays, expiring documents),
// runs the pure generator in lib/planning/prep.ts, and upserts coordinated plans +
// timed steps. Idempotent per source signal. RLS-scoped; no mock data.

import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { generatePrepPlans, type HorizonSignal } from '@/lib/planning/prep';
import { nextBirthdayDate } from '@/lib/moments/birthdays';

export type GenerateResult = { ok: boolean; error?: string; plans?: number };

export async function generatePrepPlansAction(): Promise<GenerateResult> {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const sb = await createServer();

  const now = new Date();
  const todayKey = now.toISOString().slice(0, 10);
  const in120 = new Date(now.getTime() + 120 * 86_400_000).toISOString().slice(0, 10);
  const in60 = new Date(now.getTime() + 60 * 86_400_000).toISOString().slice(0, 10);

  const [trips, members, docs] = await Promise.all([
    sb.from('vacations').select('id, title, start_date').eq('family_id', familyId).gte('start_date', todayKey).lte('start_date', in120),
    sb.from('family_members').select('id, display_name, birthday').eq('family_id', familyId).not('birthday', 'is', null),
    sb.from('documents').select('id, title, expires_at').eq('family_id', familyId).not('expires_at', 'is', null).gte('expires_at', todayKey).lte('expires_at', in60),
  ]);

  const firstErr = [trips, members, docs].find((r) => r.error)?.error;
  if (firstErr) return { ok: false, error: firstErr.message };

  const signals: HorizonSignal[] = [];
  for (const t of trips.data ?? []) {
    if (t.start_date) signals.push({ id: t.id, kind: 'trip', title: t.title ?? 'Trip', date: t.start_date });
  }
  for (const m of members.data ?? []) {
    const next = m.birthday ? nextBirthdayDate(m.birthday, now) : null;
    if (next) signals.push({ id: m.id, kind: 'birthday', title: `${m.display_name}'s Birthday`, date: next.toISOString().slice(0, 10) });
  }
  for (const d of docs.data ?? []) {
    if (d.expires_at) signals.push({ id: d.id, kind: 'doc_expiry', title: d.title ?? 'Document', date: d.expires_at });
  }

  const plans = generatePrepPlans(signals, now);
  if (plans.length === 0) return { ok: true, plans: 0 };

  // 1) Upsert the plans (one per source signal).
  const planRows = plans.map((p) => ({
    family_id: familyId, signal_kind: p.kind, signal_id: p.signalId,
    title: p.title, target_date: p.targetDate, urgency: p.urgency, status: 'active', created_by: ctx.user.id,
  }));
  const { error: planErr } = await sb.from('prep_plans').upsert(planRows, { onConflict: 'family_id,signal_kind,signal_id' });
  if (planErr) return { ok: false, error: planErr.message };

  // 2) Resolve plan ids by (signal_kind, signal_id).
  const { data: idRows, error: readErr } = await sb.from('prep_plans')
    .select('id, signal_kind, signal_id').eq('family_id', familyId);
  if (readErr) return { ok: false, error: readErr.message };
  const idByKey = new Map<string, string>();
  for (const r of idRows ?? []) idByKey.set(`${r.signal_kind}:${r.signal_id}`, r.id);

  // 3) Upsert the steps (preserve is_done on existing steps by not overwriting it).
  const stepRows = plans.flatMap((p) => {
    const planId = idByKey.get(`${p.kind}:${p.signalId}`);
    if (!planId) return [];
    return p.steps.map((s, i) => ({
      family_id: familyId, plan_id: planId, label: s.label, href: s.href,
      due_date: s.dueDate, lead_days: s.leadDays, sort_order: i,
    }));
  });
  if (stepRows.length) {
    const { error: stepErr } = await sb.from('prep_plan_steps')
      .upsert(stepRows, { onConflict: 'family_id,plan_id,label', ignoreDuplicates: true });
    if (stepErr) return { ok: false, error: stepErr.message };
  }

  return { ok: true, plans: plans.length };
}
