import type { Metadata } from 'next';
import { Activity, AlertTriangle, Lightbulb, Gauge } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { gatherSignals } from '@/lib/family/signals';
import { PageHeader } from '@/components/app/page-header';
import { SectionCard, ScoreRing, LevelBadge, MiniEmpty } from '@/components/family/shell';
import { QuickAdd } from '@/components/family/quick-add';
import { fmtDate } from '@/lib/utils/format';

export const metadata: Metadata = { title: 'Stress Prediction' };
export const dynamic = 'force-dynamic';

export default async function FamilyStressPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const [{ stress }, { data: members }, { data: signals }] = await Promise.all([
    gatherSignals(familyId),
    supabase.from('family_members').select('id, display_name').eq('family_id', familyId).eq('is_active', true),
    supabase.from('family_stress_signals').select('*').eq('family_id', familyId)
      .order('occurred_on', { ascending: false }).limit(12),
  ]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Family Stress Prediction"
        description="A planning signal built from your real schedule — not a medical assessment."
        action={
          <QuickAdd
            table="family_stress_signals"
            title="Log a signal"
            members={members ?? []}
            fields={[
              { name: 'signal_type', label: 'Signal', type: 'select', required: true, options: [
                { value: 'poor_sleep', label: 'Poor sleep' },
                { value: 'off_routine', label: 'Off routine' },
                { value: 'big_deadline', label: 'Big deadline' },
                { value: 'travel', label: 'Travel' },
                { value: 'illness', label: 'Illness' },
                { value: 'other', label: 'Other' },
              ] },
              { name: 'member_id', label: 'Who', type: 'member' },
              { name: 'occurred_on', label: 'Date', type: 'date' },
              { name: 'notes', label: 'Notes', type: 'textarea' },
            ]}
          />
        }
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <SectionCard title="This Week's Load" className="lg:col-span-1">
          <div className="flex flex-col items-center gap-3 py-2">
            <ScoreRing pct={stress.score} label="load" size={160} />
            <LevelBadge level={stress.level} />
          </div>
        </SectionCard>

        <SectionCard title="Risk Factors" description="What's driving the score" className="lg:col-span-2">
          {stress.factors.length > 0 ? (
            <ul className="space-y-2.5">
              {stress.factors.map((f) => (
                <li key={f.label} className="flex items-center gap-3 rounded-xl bg-surface/40 p-3">
                  <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-orange-500/15">
                    <AlertTriangle className="h-4 w-4 text-orange-300" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{f.label}</p>
                    <p className="text-xs text-muted">{f.detail}</p>
                  </div>
                  <span className="text-xs font-bold text-orange-300 tabular-nums">+{f.points}</span>
                </li>
              ))}
            </ul>
          ) : (
            <MiniEmpty icon={Gauge} text="No stress factors detected this week." />
          )}
        </SectionCard>
      </div>

      <SectionCard title="Suggested Fixes" description="Lighten the week with these reschedules">
        <ul className="space-y-2.5">
          {stress.suggestions.map((s, i) => (
            <li key={i} className="flex items-start gap-3 rounded-xl bg-surface/40 p-3">
              <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
              <p className="text-sm text-fg/90">{s}</p>
            </li>
          ))}
        </ul>
      </SectionCard>

      <SectionCard title="Logged Signals" description="Self-reported inputs that refine the forecast">
        {signals && signals.length > 0 ? (
          <ul className="divide-y divide-border">
            {signals.map((s) => {
              const who = (members ?? []).find((m) => m.id === s.member_id);
              return (
                <li key={s.id} className="flex items-center gap-3 py-2.5 text-sm">
                  <span className="w-24 shrink-0 text-xs text-muted">{fmtDate(s.occurred_on)}</span>
                  <span className="flex-1 capitalize">{s.signal_type.replace(/_/g, ' ')}</span>
                  {who && <span className="text-xs text-muted">{who.display_name}</span>}
                </li>
              );
            })}
          </ul>
        ) : (
          <MiniEmpty icon={Activity} text="No signals logged yet." />
        )}
      </SectionCard>
    </div>
  );
}
