import type { Metadata } from 'next';
import { Stethoscope, Pill, CalendarHeart, ShieldPlus, AlertTriangle, Syringe } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isMissingTableError } from '@/lib/supabase/errors';
import { isManager } from '@/lib/constants/roles';
import { PageHeader } from '@/components/app/page-header';
import { StatTile, SectionCard, MiniEmpty } from '@/components/family/shell';
import { ErrorState } from '@/components/ui/states';
import { fmtDateTime } from '@/lib/utils/format';

export const metadata: Metadata = { title: 'Family Health' };
export const dynamic = 'force-dynamic';

export default async function FamilyHealthPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  const now = new Date().toISOString();
  const in30 = new Date(Date.now() + 30 * 86400000).toISOString();

  // Health data is sensitive — surfaced only to managers in summary form here.
  const manager = isManager(ctx.active.role);

  const [membersRes, apptsRes, medsRes, profilesRes, providersRes] = await Promise.all([
    supabase.from('family_members').select('id, display_name').eq('family_id', familyId).eq('is_active', true),
    supabase.from('appointments').select('*').eq('family_id', familyId).gte('starts_at', now).lte('starts_at', in30).order('starts_at').limit(8),
    supabase.from('medications').select('*').eq('family_id', familyId).eq('is_active', true).limit(12),
    manager ? supabase.from('medical_profiles').select('member_id, allergies, blood_type, conditions').eq('family_id', familyId) : Promise.resolve({ data: [], error: null }),
    supabase.from('health_providers').select('id, name, specialty, phone').eq('family_id', familyId).limit(8),
  ]);

  // Health data is safety-critical: a dropped error would render "No allergies
  // or conditions recorded" (when a child has a life-threatening allergy), "No
  // active medications", or "No upcoming appointments" — a reassuring-but-wrong
  // medical summary a caregiver could rely on. Fail closed on a real read
  // error; a genuinely missing table (unapplied migration) is still tolerated
  // as empty so a partial env degrades rather than hard-fails.
  const healthError = [membersRes.error, apptsRes.error, medsRes.error, profilesRes.error, providersRes.error]
    .find((e) => e && !isMissingTableError(e));
  if (healthError) {
    console.error('[dashboard/family-health] health read failed', healthError);
    return <ErrorState message="Could not load your family health summary from Supabase. Refresh and try again." />;
  }

  const members = membersRes.data;
  const appts = apptsRes.data;
  const meds = medsRes.data;
  const profiles = profilesRes.data;
  const providers = providersRes.data;

  const nameById = new Map((members ?? []).map((m) => [m.id, m.display_name]));

  return (
    <div className="space-y-5">
      <PageHeader title="Family Health Coordinator" description="Appointments, medications, providers and emergency medical summaries." />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile href="/dashboard/medical" label="Appts (30d)" value={appts?.length ?? 0} icon={CalendarHeart} accent="bg-rose-500" sublabel="Medical" />
        <StatTile href="/dashboard/medical" label="Active meds" value={meds?.length ?? 0} icon={Pill} accent="bg-violet-600" sublabel="Medications" />
        <StatTile href="/dashboard/medical" label="Providers" value={providers?.length ?? 0} icon={Stethoscope} accent="bg-blue-600" sublabel="Doctors" />
        <StatTile href="/dashboard/family-emergency" label="Emergency" value="Card" icon={ShieldPlus} accent="bg-emerald-600" sublabel="Med summary" />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <SectionCard title="Upcoming Appointments" viewAllHref="/dashboard/medical">
          {appts && appts.length > 0 ? (
            <ul className="divide-y divide-border">
              {appts.map((a) => (
                <li key={a.id} className="flex items-center gap-3 py-2.5">
                  <CalendarHeart className="h-4 w-4 shrink-0 text-rose-400" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{a.title}</p>
                    <p className="text-xs text-muted">{[a.member_id ? nameById.get(a.member_id) : null, a.provider].filter(Boolean).join(' · ')}</p>
                  </div>
                  <span className="text-xs text-muted">{fmtDateTime(a.starts_at)}</span>
                </li>
              ))}
            </ul>
          ) : <MiniEmpty icon={CalendarHeart} text="No upcoming appointments." />}
        </SectionCard>

        <SectionCard title="Active Medications" viewAllHref="/dashboard/medical">
          {meds && meds.length > 0 ? (
            <ul className="divide-y divide-border">
              {meds.map((m) => (
                <li key={m.id} className="flex items-center gap-3 py-2.5">
                  <Pill className="h-4 w-4 shrink-0 text-violet-400" />
                  <span className="min-w-0 flex-1 truncate text-sm">{m.name}</span>
                  {m.dosage && <span className="text-xs text-muted">{m.dosage}</span>}
                  {m.member_id && <span className="text-xs text-muted">{nameById.get(m.member_id)}</span>}
                </li>
              ))}
            </ul>
          ) : <MiniEmpty icon={Pill} text="No active medications." />}
        </SectionCard>
      </div>

      {manager && (
        <SectionCard title="Allergy & Condition Watch" description="Restricted summary — visible to parents and adults only">
          {profiles && profiles.length > 0 ? (
            <ul className="grid gap-3 sm:grid-cols-2">
              {profiles.filter((p) => p.allergies || p.conditions).map((p) => (
                <li key={p.member_id} className="rounded-xl border border-border bg-surface/40 p-3">
                  <p className="text-sm font-semibold">{nameById.get(p.member_id) ?? 'Member'}</p>
                  {p.allergies && <p className="mt-1 flex items-start gap-1.5 text-xs text-orange-300"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {p.allergies}</p>}
                  {p.conditions && <p className="mt-1 flex items-start gap-1.5 text-xs text-muted"><Syringe className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {p.conditions}</p>}
                </li>
              ))}
            </ul>
          ) : <MiniEmpty icon={ShieldPlus} text="No allergies or conditions recorded." />}
        </SectionCard>
      )}
    </div>
  );
}
